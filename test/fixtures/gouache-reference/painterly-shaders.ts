// Adapted from Maxime Heckel's painterly shader and Kyprianidis et al. (2010).
// https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders/
// https://www.kyprianidis.com/p/tpcg2010/
export const vertexSource = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
uniform bool uFlipY;

void main() {
  vec2 uv = aPosition * 0.5 + 0.5;
  vUv = vec2(uv.x, uFlipY ? 1.0 - uv.y : uv.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// Average gradient products before deriving orientation. Encode the doubled
// angle, not a signed eigenvector, so texture interpolation has no sign seams.
export const flowSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uImage;
uniform vec2 uResolution;

vec3 colorAt(vec2 offset) {
  return texture(uImage, vUv + offset / uResolution).rgb;
}

void main() {
  vec3 tensor = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y)) * 2.0;
      vec3 dx = (colorAt(offset + vec2(1.0, 0.0)) -
                 colorAt(offset - vec2(1.0, 0.0))) * 0.5;
      vec3 dy = (colorAt(offset + vec2(0.0, 1.0)) -
                 colorAt(offset - vec2(0.0, 1.0))) * 0.5;
      float weight = float((x == 0 ? 2 : 1) * (y == 0 ? 2 : 1));
      tensor += vec3(dot(dx, dx), dot(dy, dy), dot(dx, dy)) * weight / 16.0;
    }
  }
  float trace = tensor.x + tensor.y;
  vec2 direction = vec2(tensor.x - tensor.y, 2.0 * tensor.z) / max(trace, 0.00001);
  fragColor = vec4(direction * 0.5 + 0.5, clamp(sqrt(trace), 0.0, 1.0), 1.0);
}`;

export const fragmentSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uImage;
uniform sampler2D uFlow;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uBrushSize;
uniform float uDirection;
uniform float uDetail;
uniform float uSoftness;
uniform float uPaper;
uniform float uPigment;
uniform float uColor;

const float PI = 3.14159265359;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
             mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), f.x), f.y);
}

void main() {
  vec3 sourceColor = texture(uImage, vUv).rgb;
  if (uStrength <= 0.0) {
    fragColor = vec4(sourceColor, 1.0);
    return;
  }

  vec3 flow = texture(uFlow, vUv).rgb;
  vec2 direction = flow.rg * 2.0 - 1.0;
  float detail = smoothstep(0.015, 0.16, flow.b) * uDetail;
  float anisotropy = min(length(direction), 0.9) * smoothstep(0.003, 0.025, flow.b) * uDirection;
  float angle = length(direction) > 0.02 ? 0.5 * atan(direction.y, direction.x) + PI * 0.5 : 0.0;
  mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  float imageScale = clamp(max(uResolution.x, uResolution.y) / 1000.0, 0.5, 1.6);
  vec2 paperUv = vUv * uResolution / imageScale;
  float pigment = noise(paperUv * 0.035);
  float radius = 5.0 * uBrushSize * imageScale * mix(1.25, 0.8, detail);
  radius *= 1.0 + (pigment - 0.5) * 0.5 * uPigment;
  vec2 axes = vec2(1.0 + anisotropy, 1.0 / (1.0 + anisotropy));

  vec3 means[8];
  vec3 squares[8];
  float weights[8];
  for (int k = 0; k < 8; k++) {
    means[k] = vec3(0.0);
    squares[k] = vec3(0.0);
    weights[k] = 0.0;
  }

  // 81 unique texture samples on a disk. Every sector uses the same dense grid;
  // rotate the weights into sector-local coordinates to avoid an axis bias.
  for (int y = -5; y <= 5; y++) {
    for (int x = -5; x <= 5; x++) {
      vec2 p = vec2(float(x), float(y)) / 5.0;
      float distanceSquared = dot(p, p);
      if (distanceSquared > 1.0) continue;
      vec2 offset = rotation * (p * axes) * radius;
      vec3 color = texture(uImage, vUv + offset / uResolution).rgb;
      float radialWeight = exp(-3.0 * distanceSquared);
      for (int k = 0; k < 8; k++) {
        float sectorAngle = float(k) * PI * 0.25;
        vec2 sector = vec2(cos(sectorAngle), sin(sectorAngle));
        float along = dot(p, sector);
        float across = dot(p, vec2(-sector.y, sector.x));
        float polynomial = max(0.0, along + 0.4 - 2.0 * across * across);
        float weight = polynomial * polynomial * radialWeight;
        means[k] += color * weight;
        squares[k] += color * color * weight;
        weights[k] += weight;
      }
    }
  }

  vec3 paintedColor = vec3(0.0);
  float totalConfidence = 0.0;
  float variances[8];
  float minimumVariance = 1.0;
  for (int k = 0; k < 8; k++) {
    vec3 mean = means[k] / max(weights[k], 0.00001);
    vec3 variance = max(squares[k] / max(weights[k], 0.00001) - mean * mean, vec3(0.0));
    means[k] = mean;
    variances[k] = dot(variance, LUMA);
    minimumVariance = min(minimumVariance, variances[k]);
  }
  for (int k = 0; k < 8; k++) {
    // Relative confidence keeps at least one weight at 1, even on noisy inputs.
    float confidence = pow((minimumVariance + 0.0001) / (variances[k] + 0.0001),
                           mix(8.0, 1.0, uSoftness));
    paintedColor += means[k] * confidence;
    totalConfidence += confidence;
  }
  paintedColor /= max(totalConfidence, 0.00001);

  // Gentle value grouping in the image's display color space. Uploaded photos
  // are already tone-mapped, so do not run them through an HDR/ACES curve again.
  float luminance = dot(paintedColor, LUMA);
  float grouped = floor(luminance * 14.0 + 0.5) / 14.0;
  paintedColor += (grouped - luminance) * 0.5 * uColor;
  paintedColor = mix(vec3(dot(paintedColor, LUMA)), paintedColor, 1.0 + 0.12 * uColor);

  // Static paper and pigment variation, baked into the exported image.
  float tooth = noise(paperUv * 0.72) - 0.5;
  float fiber = noise(paperUv * vec2(0.16, 1.1)) - 0.5;
  float grain = hash(floor(paperUv * 1.4)) - 0.5;
  float coverage = (pigment - 0.5) * 0.06 * uPigment +
                   (tooth * 0.045 + fiber * 0.02 + grain * 0.02) * uPaper;
  paintedColor += coverage * (0.35 + 0.65 * (1.0 - luminance));
  paintedColor = clamp(paintedColor, 0.0, 1.0);
  fragColor = vec4(mix(sourceColor, paintedColor, uStrength), 1.0);
}`;
