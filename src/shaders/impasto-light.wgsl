struct Settings { resolution: vec2f, strength: f32, thickness: f32 }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var painted: texture_2d<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var<uniform> settings: Settings;
fn hash(p: vec2f) -> f32 {
  var q = fract(p.xyx * 0.1031);
  q += vec3f(dot(q, q.yzx + vec3f(33.33)));
  return fract((q.x + q.y) * q.z);
}
fn heightAt(uv: vec2f) -> f32 { return textureSampleLevel(painted, imageSampler, uv, 0.0).a; }
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let original = textureSampleLevel(source, imageSampler, uv, 0.0).rgb;
  if (settings.strength <= 0.0) { return vec4f(original, 1.0); }
  let paint = textureSampleLevel(painted, imageSampler, uv, 0.0);
  let texel = vec2f(1.0) / settings.resolution;
  let left = heightAt(uv - vec2f(texel.x, 0));
  let right = heightAt(uv + vec2f(texel.x, 0));
  let top = heightAt(uv - vec2f(0, texel.y));
  let bottom = heightAt(uv + vec2f(0, texel.y));
  let scale = max(settings.resolution.x, settings.resolution.y) / 1000.0;
  let normal = normalize(vec3f((left - right) * 5.0 * scale * settings.thickness,
                              (top - bottom) * 5.0 * scale * settings.thickness, 1.0));
  let light = normalize(vec3f(-0.6, -0.75, 1.25));
  let diffuse = dot(normal, light);
  let halfVector = normalize(light + vec3f(0, 0, 1));
  let specular = pow(max(dot(normal, halfVector), 0.0), 28.0);
  let flatSpecular = pow(halfVector.z, 28.0);
  let cavity = max(0.0, (left + right + top + bottom) * 0.25 - paint.a);
  var color = paint.rgb * (1.0 + (diffuse - light.z) * 0.4);
  color += vec3f(1.0, 0.96, 0.89) * (specular - flatSpecular) * 0.14 * settings.thickness;
  color *= 1.0 - min(cavity * 1.2 * settings.thickness, 0.1);
  // Anchor grain to pixel centers so UV interpolation cannot change hash cells.
  let cloth = (floor(uv * settings.resolution) + vec2f(0.5)) / max(scale, 1.0);
  let fiber = hash(floor(cloth * 0.48));
  let weave = sin(cloth * 2.7 + vec2f((fiber - 0.5) * 0.65));
  let grain = hash(floor(cloth * 1.3)) - 0.5;
  let canvas = (weave.x * weave.y) * 0.009 + (fiber - 0.5) * 0.014 + grain * 0.012;
  let exposed = 1.0 - smoothstep(0.075, 0.15, paint.a);
  color += vec3f(canvas * exposed);
  return vec4f(mix(original, clamp(color, vec3f(0.0), vec3f(1.0)), settings.strength), 1.0);
}
