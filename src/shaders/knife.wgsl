struct Settings { resolution: vec2f, brush: f32 }
@group(0) @binding(0) var paint: texture_2d<f32>;
@group(0) @binding(1) var flow: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var<uniform> settings: Settings;
fn hash(p: vec2f) -> f32 {
  var q = fract(p.xyx * 0.1031);
  q += vec3f(dot(q, q.yzx + vec3f(33.33)));
  return fract((q.x + q.y) * q.z);
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (vec2f(3.0) - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1, 0)), f.x),
             mix(hash(i + vec2f(0, 1)), hash(i + vec2f(1)), f.x), f.y);
}
fn paintAt(uv: vec2f) -> vec3f {
  return textureSampleLevel(paint, imageSampler, uv, 0.0).rgb;
}
@fragment fn fs_main(@location(0) vUv: vec2f) -> @location(0) vec4f {
  let pixel = vUv * settings.resolution;
  let scale = max(settings.resolution.x, settings.resolution.y) / 1000.0;
  let baseColor = paintAt(vUv);
  var color = baseColor;
  var height = 0.06;
  // Broad scumbles and smaller loaded marks carry matching color and height.
  for (var layer = 0; layer < 2; layer++) {
    let cellSize = 11.0 * settings.brush * scale * select(1.0, 2.3, layer == 0);
    let cell = floor(pixel / cellSize);
    var best = -1.0;
    var coatColor = color;
    var coatHeight = height;
    for (var y = -2; y <= 2; y++) {
      for (var x = -2; x <= 2; x++) {
        let id = cell + vec2f(f32(x), f32(y));
        let seed = id + vec2f(f32(layer) * 173.0);
        let order = hash(seed + vec2f(5.7));
        if (order < best) { continue; }
        let center = (id + vec2f(0.5) + 0.78 * (vec2f(hash(seed), hash(seed + vec2f(19.3))) - vec2f(0.5))) * cellSize;
        let uv = clamp(center / settings.resolution, vec2f(0.0), vec2f(1.0));
        let directionMap = textureSampleLevel(flow, imageSampler, uv, 0.0).rgb;
        let direction = directionMap.rg * 2.0 - vec2f(1.0);
        let confidence = smoothstep(0.005, 0.06, directionMap.b);
        let probe = vec2f(cellSize * 0.6) / settings.resolution;
        let variation = length(paintAt(uv + vec2f(probe.x, 0)) - paintAt(uv - vec2f(probe.x, 0))) +
                        length(paintAt(uv + vec2f(0, probe.y)) - paintAt(uv - vec2f(0, probe.y)));
        let activity = smoothstep(0.03, 0.25, variation);
        if (layer == 1 && activity < 0.12) { continue; }
        let loading = noise(center / (scale * 92.0) + vec2f(23.0));
        if (layer == 1 && hash(seed + vec2f(137.0)) > mix(0.18, 0.88, loading)) { continue; }
        var angle = 0.5 * atan2(direction.y, direction.x) + 1.5707963;
        angle = mix(-0.1, angle, confidence) + (hash(seed + vec2f(8.1)) - 0.5) * mix(0.3, 1.4, activity);
        let along = vec2f(cos(angle), sin(angle));
        let across = vec2f(-along.y, along.x);
        let delta = pixel - center;
        var p = vec2f(dot(delta, along), dot(delta, across)) / cellSize;
        let halfLength = mix(0.6, 1.5, hash(seed + vec2f(42.0)));
        let halfWidth = mix(0.35, 0.64, hash(seed + vec2f(71.0)));
        let bend = (hash(seed + vec2f(113.0)) - 0.5) * mix(0.12, 0.65, activity);
        let progress = p.x / halfLength;
        p.y -= bend * (progress * progress - 0.3);
        let chips = noise(vec2f(p.y * 7.0, order * 31.0));
        let end = halfLength - 0.16 * chips - 0.12 * p.y;
        let side = halfWidth * (1.0 - 0.12 * p.x) + 0.035 * sin(p.x * 9.0 + order * 40.0);
        let edge = min(end - abs(p.x), side - abs(p.y));
        var coverage = smoothstep(0.0, 1.1 * scale / cellSize, edge);
        let tooth = noise(vec2f(p.x * 3.0, p.y * 19.0) + seed);
        let dryEdge = (1.0 - smoothstep(0.0, 0.2, edge)) * 0.55;
        coverage *= smoothstep(dryEdge, dryEdge + 0.18, tooth);
        coverage *= select(1.0, 0.38, layer == 0);
        if (coverage <= 0.0) { continue; }
        var ink = paintAt(uv);
        let mismatch = length(ink - baseColor);
        if (mismatch > mix(0.3, 0.2, activity)) { continue; }
        let groove = p.y * cellSize / (1.7 * scale) + 0.12 * p.x * p.x + order * 43.0;
        var ridge = pow(noise(vec2f(groove, order * 61.0)), 3.0);
        ridge *= mix(0.3, 1.0, hash(seed + vec2f(91.0)));
        let rim = exp(-max(edge, 0.0) * cellSize / (1.8 * scale));
        let body = smoothstep(0.0, 2.5 * scale / cellSize, edge);
        let pressure = 0.85 + 0.15 * p.x / halfLength;
        var relief = (0.10 + order * 0.04 + ridge * 0.24 + rim * 0.035) * body * pressure;
        relief *= mix(0.07, 1.0, activity);
        relief *= select(1.0, 0.18, layer == 0);
        ink += vec3f((hash(seed + vec2f(15.0)) - 0.5) * mix(0.008, 0.035, activity));
        let colorOffset = along * halfLength * 0.6 * cellSize / settings.resolution;
        let bendOffset = across * bend * 0.06 * cellSize / settings.resolution;
        let startInk = paintAt(clamp(uv - colorOffset + bendOffset, vec2f(0.0), vec2f(1.0)));
        let endInk = paintAt(clamp(uv + colorOffset + bendOffset, vec2f(0.0), vec2f(1.0)));
        let dragged = mix(startInk, endInk, smoothstep(-0.85, 0.85, progress));
        ink += clamp(dragged - ink, vec3f(-0.16), vec3f(0.16)) * 0.35;
        ink += vec3f((ridge - 0.15) * 0.014 * activity);
        coatColor = mix(color, ink, coverage);
        coatHeight = mix(height, 0.06 + relief, coverage);
        best = order;
      }
    }
    color = coatColor;
    height = coatHeight;
  }
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), height);
}
