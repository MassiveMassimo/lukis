// Port of the preserved Gouache anisotropic Kuwahara underpainting.
// Maxime Heckel and Kyprianidis et al. (2010); see docs/impasto.md.
struct Settings { resolution: vec2f, brush: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var flow: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var<uniform> settings: Settings;
const PI = 3.14159265359;
const LUMA = vec3f(0.299, 0.587, 0.114);
fn hash(p: vec2f) -> f32 {
  var q = fract(p.xyx * 0.1031);
  q += vec3f(dot(q, q.yzx + vec3f(33.33)));
  return fract((q.x + q.y) * q.z);
}
fn noise(p: vec2f) -> f32 {
  let cell = floor(p);
  var f = fract(p);
  f = f * f * (vec2f(3.0) - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2f(1, 0)), f.x),
             mix(hash(cell + vec2f(0, 1)), hash(cell + vec2f(1)), f.x), f.y);
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let directionMap = textureSampleLevel(flow, imageSampler, uv, 0.0).rgb;
  let direction = directionMap.rg * 2.0 - vec2f(1.0);
  let detail = smoothstep(0.015, 0.16, directionMap.b) * 0.6;
  let anisotropy = min(length(direction), 0.9) * smoothstep(0.003, 0.025, directionMap.b) * 0.85;
  var angle = 0.0;
  if (length(direction) > 0.02) { angle = 0.5 * atan2(direction.y, direction.x) + PI * 0.5; }
  let rotation = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
  let imageScale = clamp(max(settings.resolution.x, settings.resolution.y) / 1000.0, 0.5, 1.6);
  let paperUv = uv * settings.resolution / imageScale;
  let pigment = noise(paperUv * 0.035);
  var radius = 5.0 * settings.brush * imageScale * mix(1.25, 0.8, detail);
  radius *= 1.0 + (pigment - 0.5) * 0.5 * 0.3;
  let axes = vec2f(1.0 + anisotropy, 1.0 / (1.0 + anisotropy));
  var means: array<vec3f, 8>;
  var squares: array<vec3f, 8>;
  var weights: array<f32, 8>;
  for (var y = -5; y <= 5; y++) {
    for (var x = -5; x <= 5; x++) {
      let p = vec2f(f32(x), f32(y)) / 5.0;
      let distanceSquared = dot(p, p);
      if (distanceSquared > 1.0) { continue; }
      let offset = rotation * (p * axes) * radius;
      let color = textureSampleLevel(source, imageSampler, uv + offset / settings.resolution, 0.0).rgb;
      let radialWeight = exp(-3.0 * distanceSquared);
      for (var k = 0; k < 8; k++) {
        let sectorAngle = f32(k) * PI * 0.25;
        let sector = vec2f(cos(sectorAngle), sin(sectorAngle));
        let along = dot(p, sector);
        let across = dot(p, vec2f(-sector.y, sector.x));
        let polynomial = max(0.0, along + 0.4 - 2.0 * across * across);
        let weight = polynomial * polynomial * radialWeight;
        means[k] += color * weight;
        squares[k] += color * color * weight;
        weights[k] += weight;
      }
    }
  }
  var paintedColor = vec3f(0.0);
  var totalConfidence = 0.0;
  var variances: array<f32, 8>;
  var minimumVariance = 1.0;
  for (var k = 0; k < 8; k++) {
    let mean = means[k] / max(weights[k], 0.00001);
    let variance = max(squares[k] / max(weights[k], 0.00001) - mean * mean, vec3f(0.0));
    means[k] = mean;
    variances[k] = dot(variance, LUMA);
    minimumVariance = min(minimumVariance, variances[k]);
  }
  for (var k = 0; k < 8; k++) {
    let confidence = pow((minimumVariance + 0.0001) / (variances[k] + 0.0001), mix(8.0, 1.0, 0.35));
    paintedColor += means[k] * confidence;
    totalConfidence += confidence;
  }
  paintedColor /= max(totalConfidence, 0.00001);
  let luminance = dot(paintedColor, LUMA);
  let grouped = floor(luminance * 14.0 + 0.5) / 14.0;
  paintedColor += vec3f((grouped - luminance) * 0.5 * 0.35);
  paintedColor = mix(vec3f(dot(paintedColor, LUMA)), paintedColor, 1.0 + 0.12 * 0.35);
  let coverage = (pigment - 0.5) * 0.06 * 0.3;
  paintedColor += vec3f(coverage * (0.35 + 0.65 * (1.0 - luminance)));
  return vec4f(clamp(paintedColor, vec3f(0.0), vec3f(1.0)), 1.0);
}
