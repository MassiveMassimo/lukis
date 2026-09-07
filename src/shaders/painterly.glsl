#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uBrush;

// Same Papari-Kuwahara kernel as painterly.wgsl and the saved renderer.
void main() {
  float minimumVariance = 1e20;
  vec3 paintedColor = vec3(0.0);
  for (int sector = 0; sector < 8; sector++) {
    float angle = float(sector) * 6.2831853 / 8.0;
    vec3 sum = vec3(0.0);
    vec3 squaredSum = vec3(0.0);
    float totalWeight = 0.0;
    for (int radius = 1; radius <= 3; radius++) {
      for (int angleStep = 0; angleStep < 5; angleStep++) {
        float angleOffset = -0.392699 + float(angleStep) * 0.196349;
        vec2 offset = float(radius) * vec2(cos(angle + angleOffset), sin(angle + angleOffset));
        vec2 coord = clamp(vUv + offset * uBrush / uResolution, vec2(0.0), vec2(1.0));
        vec3 color = texture(uSource, coord).rgb;
        float polynomial = (offset.x + 0.1) - 0.5 * offset.y * offset.y;
        float weight = max(0.0, polynomial * polynomial);
        sum += color * weight;
        squaredSum += color * color * weight;
        totalWeight += weight;
      }
    }
    float safeWeight = max(totalWeight, 0.0001);
    vec3 average = sum / safeWeight;
    float variance = dot(squaredSum / safeWeight - average * average, vec3(0.299, 0.587, 0.114));
    if (variance < minimumVariance) {
      minimumVariance = variance;
      paintedColor = average;
    }
  }
  fragColor = vec4(paintedColor, 1.0);
}
