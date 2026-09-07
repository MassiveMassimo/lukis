#version 300 es
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
}
