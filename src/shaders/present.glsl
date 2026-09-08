#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uProgress;
uniform float u_height;
uniform float u_width;
uniform float u_broadening;
uniform float u_refraction;
uniform float u_dispersion;
uniform float u_colorBoost;
uniform float u_sheen;
uniform float u_shading;
uniform float u_feather;
uniform float u_strength;
uniform float u_count;
uniform float u_spacing;
uniform float u_echo;
uniform float u_distance;
uniform float u_amplitude;
uniform float u_blurPx;

// C2 compact support matches the WebGPU wave.
float compactShoulder(float offset) {
  float q = clamp(abs(offset) - 2.0, 0.0, 1.0);
  float edge = q * q * q * (q * (q * 6.0 - 15.0) + 10.0);
  return exp(-0.5 * offset * offset) * (1.0 - edge);
}

float heightField(vec2 position) {
  float distance = sqrt(dot(position, position) + 0.018 * 0.018);
  float radius = -0.17 + u_distance;
  float width = u_width + u_broadening * u_distance;
  float trailingOffset = 0.28 * u_width / 0.205;
  float waveHeight = 0.0;
  float weight = 1.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= u_count) break;
    float waveRadius = radius - float(i) * u_spacing;
    float shoulder = (distance - waveRadius) / width;
    float trailing = (distance - waveRadius + trailingOffset) / (width * 1.62);
    float birth = i == 0 ? 1.0 : smoothstep(-width, 0.0, waveRadius);
    waveHeight += (compactShoulder(shoulder) - 0.23 * compactShoulder(trailing)) * weight * birth;
    weight *= u_echo;
  }
  return u_height * u_strength * u_amplitude * waveHeight;
}

vec3 imageAt(vec2 uv) {
  return texture(uSource, clamp(uv, vec2(0.0005), vec2(0.9995))).rgb;
}

vec3 samplePainting(vec2 uv, vec2 spread) {
  vec3 center = imageAt(uv);
  if (u_blurPx <= 0.0 || dot(spread, spread) <= 0.0) return center;
  return center * 0.28
    + imageAt(uv + vec2(spread.x, 0.0)) * 0.12
    + imageAt(uv - vec2(spread.x, 0.0)) * 0.12
    + imageAt(uv + vec2(0.0, spread.y)) * 0.12
    + imageAt(uv - vec2(0.0, spread.y)) * 0.12
    + imageAt(uv + spread * 0.7071) * 0.06
    + imageAt(uv - spread * 0.7071) * 0.06
    + imageAt(uv + vec2(spread.x, -spread.y) * 0.7071) * 0.06
    + imageAt(uv + vec2(-spread.x, spread.y) * 0.7071) * 0.06;
}

void main() {
  if (uProgress <= 0.0) { fragColor = vec4(0.0); return; }
  if (uProgress >= 1.0 && (u_amplitude == 0.0 || u_strength <= 0.0 || u_height <= 0.0)) {
    fragColor = texture(uSource, vUv);
    return;
  }
  // Keep these display-only optics in sync with present.wgsl.
  vec2 aspect = uResolution / min(uResolution.x, uResolution.y);
  vec2 position = (vUv - 0.5) * aspect;
  float distance = length(position);
  float maxRadius = length(aspect) * 0.5;
  float feather = u_feather;
  float radius = mix(-feather, maxRadius + feather, uProgress);
  float alpha = 1.0 - smoothstep(radius - feather, radius + feather, distance);
  if (alpha <= 0.0) { fragColor = vec4(0.0); return; }
  float height = heightField(position);
  float epsilon = 0.002;
  vec2 gradient = vec2(
    heightField(position + vec2(epsilon, 0.0)) - heightField(position - vec2(epsilon, 0.0)),
    heightField(position + vec2(0.0, epsilon)) - heightField(position - vec2(0.0, epsilon))
  ) / (2.0 * epsilon);
  vec3 normal = normalize(vec3(-gradient, 1.0));
  vec3 ray = refract(vec3(0.0, 0.0, -1.0), normal, 1.0 / 1.38);
  vec2 refracted = ray.xy / max(abs(ray.z), 0.2) * u_refraction;
  vec2 perspective = -position * height * 0.19;
  vec2 edgeDistance = min(vUv, vec2(1.0) - vUv);
  vec2 edgeFreedom = smoothstep(vec2(0.0), vec2(0.22), edgeDistance);
  vec2 warped = vUv + (refracted + perspective) / aspect * edgeFreedom;
  float activity = clamp(length(gradient) * 2.0 + abs(height) * 1.7, 0.0, 1.0);
  vec2 dispersion = refracted / aspect * u_dispersion * edgeFreedom;
  vec2 spread = u_blurPx * (0.1 + 0.9 * activity) * activity / uResolution * edgeFreedom;
  vec3 center = imageAt(warped);
  vec3 dispersed = vec3(imageAt(warped + dispersion).r, center.g, imageAt(warped - dispersion).b);
  vec3 color = mix(samplePainting(warped, spread), center, 0.23);
  color += (dispersed - center) * 0.23 * u_colorBoost;

  vec3 reflected = reflect(vec3(0.0, 0.0, -1.0), normal);
  vec2 lightCenter = vec2(-0.24, -0.38);
  vec2 lightWidth = vec2(0.66, 0.82);
  vec2 lightPosition = (reflected.xy - lightCenter) / lightWidth;
  vec2 flatPosition = -lightCenter / lightWidth;
  float light = exp(-dot(lightPosition, lightPosition) * 1.15) - exp(-dot(flatPosition, flatPosition) * 1.15);
  float brightness = (max(light, 0.0) + max(height, 0.0) * (0.46 / 0.60)) * u_sheen;
  color *= 1.0 + min(light, 0.0) * u_shading;
  color += (vec3(1.0) - color) * brightness;
  fragColor = vec4(clamp(color, 0.0, 1.0) * alpha, alpha);
}
