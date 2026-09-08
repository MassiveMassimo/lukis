struct Reveal {
  resolution: vec2f,
  progress: f32,
  height: f32,
  width: f32,
  broadening: f32,
  refraction: f32,
  dispersion: f32,
  colorBoost: f32,
  sheen: f32,
  shading: f32,
  feather: f32,
  strength: f32,
  count: f32,
  spacing: f32,
  echo: f32,
  distance: f32,
  amplitude: f32,
  blurPx: f32,
}
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> reveal: Reveal;

// C2 boundary keeps height, slope and curvature smooth as the wave reaches rest.
fn compactShoulder(offset: f32) -> f32 {
  let q = clamp(abs(offset) - 2.0, 0.0, 1.0);
  let edge = q * q * q * (q * (q * 6.0 - 15.0) + 10.0);
  return exp(-0.5 * offset * offset) * (1.0 - edge);
}

fn heightField(position: vec2f) -> f32 {
  let distance = sqrt(dot(position, position) + 0.018 * 0.018);
  let radius = -0.17 + reveal.distance;
  let width = reveal.width + reveal.broadening * reveal.distance;
  let trailingOffset = 0.28 * reveal.width / 0.205;
  var waveHeight = 0.0;
  var weight = 1.0;
  for (var i = 0; i < 6; i++) {
    if (f32(i) >= reveal.count) { break; }
    let waveRadius = radius - f32(i) * reveal.spacing;
    let shoulder = (distance - waveRadius) / width;
    let trailing = (distance - waveRadius + trailingOffset) / (width * 1.62);
    let birth = select(smoothstep(-width, 0.0, waveRadius), 1.0, i == 0);
    waveHeight += (compactShoulder(shoulder) - 0.23 * compactShoulder(trailing)) * weight * birth;
    weight *= reveal.echo;
  }
  return reveal.height * reveal.strength * reveal.amplitude * waveHeight;
}

fn imageAt(uv: vec2f) -> vec3f {
  return textureSampleLevel(image, imageSampler, clamp(uv, vec2f(0.0005), vec2f(0.9995)), 0.0).rgb;
}

fn samplePainting(uv: vec2f, spread: vec2f) -> vec3f {
  let center = imageAt(uv);
  if (reveal.blurPx <= 0.0 || dot(spread, spread) <= 0.0) { return center; }
  return center * 0.28
    + imageAt(uv + vec2f(spread.x, 0.0)) * 0.12
    + imageAt(uv - vec2f(spread.x, 0.0)) * 0.12
    + imageAt(uv + vec2f(0.0, spread.y)) * 0.12
    + imageAt(uv - vec2f(0.0, spread.y)) * 0.12
    + imageAt(uv + spread * 0.7071) * 0.06
    + imageAt(uv - spread * 0.7071) * 0.06
    + imageAt(uv + vec2f(spread.x, -spread.y) * 0.7071) * 0.06
    + imageAt(uv + vec2f(-spread.x, spread.y) * 0.7071) * 0.06;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (reveal.progress <= 0.0) { return vec4f(0.0); }
  if (reveal.progress >= 1.0 && (reveal.amplitude == 0.0 || reveal.strength <= 0.0 || reveal.height <= 0.0)) {
    return textureSampleLevel(image, imageSampler, uv, 0.0);
  }
  // The center is fixed. Short-side units keep the broad wave circular.
  let aspect = reveal.resolution / min(reveal.resolution.x, reveal.resolution.y);
  let position = (uv - 0.5) * aspect;
  let distance = length(position);
  let maxRadius = length(aspect) * 0.5;
  let feather = reveal.feather;
  let radius = mix(-feather, maxRadius + feather, reveal.progress);
  let alpha = 1.0 - smoothstep(radius - feather, radius + feather, distance);
  if (alpha <= 0.0) { return vec4f(0.0); }
  let height = heightField(position);
  let epsilon = 0.002;
  let gradient = vec2f(
    heightField(position + vec2f(epsilon, 0.0)) - heightField(position - vec2f(epsilon, 0.0)),
    heightField(position + vec2f(0.0, epsilon)) - heightField(position - vec2f(0.0, epsilon))
  ) / (2.0 * epsilon);
  let normal = normalize(vec3f(-gradient, 1.0));
  let ray = refract(vec3f(0.0, 0.0, -1.0), normal, 1.0 / 1.38);
  let refracted = ray.xy / max(abs(ray.z), 0.2) * reveal.refraction;
  let perspective = -position * height * 0.19;
  // Broad component-wise anchoring prevents repeated pixels at image edges.
  let edgeDistance = min(uv, vec2f(1.0) - uv);
  let edgeFreedom = smoothstep(vec2f(0.0), vec2f(0.22), edgeDistance);
  let warped = uv + (refracted + perspective) / aspect * edgeFreedom;
  let activity = clamp(length(gradient) * 2.0 + abs(height) * 1.7, 0.0, 1.0);
  let dispersion = refracted / aspect * reveal.dispersion * edgeFreedom;
  let spread = reveal.blurPx * (0.1 + 0.9 * activity) * activity / reveal.resolution * edgeFreedom;
  let center = imageAt(warped);
  let dispersed = vec3f(imageAt(warped + dispersion).r, center.g, imageAt(warped - dispersion).b);
  var color = mix(samplePainting(warped, spread), center, 0.23);
  color += (dispersed - center) * 0.23 * reveal.colorBoost;

  // Neutral area light, relative to the flat sheet. No colored edge emission.
  let reflected = reflect(vec3f(0.0, 0.0, -1.0), normal);
  let lightCenter = vec2f(-0.24, -0.38);
  let lightWidth = vec2f(0.66, 0.82);
  let lightPosition = (reflected.xy - lightCenter) / lightWidth;
  let flatPosition = -lightCenter / lightWidth;
  let light = exp(-dot(lightPosition, lightPosition) * 1.15) - exp(-dot(flatPosition, flatPosition) * 1.15);
  let brightness = (max(light, 0.0) + max(height, 0.0) * (0.46 / 0.60)) * reveal.sheen;
  color *= 1.0 + min(light, 0.0) * reveal.shading;
  color += (vec3f(1.0) - color) * brightness;
  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)) * alpha, alpha);
}
