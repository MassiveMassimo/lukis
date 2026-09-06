struct Settings { resolution: vec2f, strength: f32, brush: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> settings: Settings;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var minimumVariance = 1e20;
  var paintedColor = vec3f(0.0);
  for (var sector = 0; sector < 8; sector++) {
    let angle = f32(sector) * 6.2831853 / 8.0;
    var sum = vec3f(0.0);
    var squaredSum = vec3f(0.0);
    var totalWeight = 0.0;
    for (var radius = 1; radius <= 3; radius++) {
      for (var angleStep = 0; angleStep < 5; angleStep++) {
        let angleOffset = -0.392699 + f32(angleStep) * 0.196349;
        let offset = f32(radius) * vec2f(cos(angle + angleOffset), sin(angle + angleOffset));
        let coord = clamp(uv + offset * settings.brush / settings.resolution, vec2f(0.0), vec2f(1.0));
        let color = textureSampleLevel(source, imageSampler, coord, 0.0).rgb;
        let polynomial = (offset.x + 0.1) - 0.5 * offset.y * offset.y;
        let weight = max(0.0, polynomial * polynomial);
        sum += color * weight;
        squaredSum += color * color * weight;
        totalWeight += weight;
      }
    }
    let safeWeight = max(totalWeight, 0.0001);
    let average = sum / safeWeight;
    let variance = dot(squaredSum / safeWeight - average * average, vec3f(0.299, 0.587, 0.114));
    if (variance < minimumVariance) {
      minimumVariance = variance;
      paintedColor = average;
    }
  }
  return vec4f(paintedColor, 1.0);
}
