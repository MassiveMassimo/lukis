struct Settings { resolution: vec2f }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> settings: Settings;

fn colorAt(uv: vec2f, offset: vec2f) -> vec3f {
  return textureSampleLevel(source, imageSampler, uv + offset / settings.resolution, 0.0).rgb;
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var tensor = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x), f32(y)) * 2.0;
      let dx = (colorAt(uv, offset + vec2f(1, 0)) - colorAt(uv, offset - vec2f(1, 0))) * 0.5;
      let dy = (colorAt(uv, offset + vec2f(0, 1)) - colorAt(uv, offset - vec2f(0, 1))) * 0.5;
      let weight = f32(select(1, 2, x == 0) * select(1, 2, y == 0));
      tensor += vec3f(dot(dx, dx), dot(dy, dy), dot(dx, dy)) * weight / 16.0;
    }
  }
  let trace = tensor.x + tensor.y;
  let direction = vec2f(tensor.x - tensor.y, 2.0 * tensor.z) / max(trace, 0.00001);
  return vec4f(direction * 0.5 + vec2f(0.5), clamp(sqrt(trace), 0.0, 1.0), 1.0);
}
