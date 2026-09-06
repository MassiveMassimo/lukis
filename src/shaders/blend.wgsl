struct Settings { resolution: vec2f, strength: f32, brush: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var painted: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var<uniform> settings: Settings;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let original = textureSampleLevel(source, imageSampler, uv, 0.0).rgb;
  let filtered = textureSampleLevel(painted, imageSampler, uv, 0.0).rgb;
  return vec4f(mix(original, filtered, settings.strength), 1.0);
}
