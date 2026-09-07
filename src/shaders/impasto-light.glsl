#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uImage;
uniform sampler2D uSurface;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uThickness;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec3 source = texture(uImage, vUv).rgb;
  if (uStrength <= 0.0) {
    fragColor = vec4(source, 1.0);
    return;
  }
  vec4 paint = texture(uSurface, vUv);
  vec2 texel = 1.0 / uResolution;
  float left = texture(uSurface, vUv - vec2(texel.x, 0)).a;
  float right = texture(uSurface, vUv + vec2(texel.x, 0)).a;
  float top = texture(uSurface, vUv - vec2(0, texel.y)).a;
  float bottom = texture(uSurface, vUv + vec2(0, texel.y)).a;
  float scale = max(uResolution.x, uResolution.y) / 1000.0;
  vec3 normal = normalize(vec3((left - right) * 5.0 * scale * uThickness,
                               (top - bottom) * 5.0 * scale * uThickness, 1.0));
  vec3 light = normalize(vec3(-0.6, -0.75, 1.25));
  float diffuse = dot(normal, light);
  vec3 halfVector = normalize(light + vec3(0, 0, 1));
  float specular = pow(max(dot(normal, halfVector), 0.0), 28.0);
  float flatSpecular = pow(halfVector.z, 28.0);
  float cavity = max(0.0, (left + right + top + bottom) * 0.25 - paint.a);
  vec3 color = paint.rgb * (1.0 + (diffuse - light.z) * 0.4);
  color += vec3(1.0, 0.96, 0.89) * (specular - flatSpecular) * 0.14 * uThickness;
  color *= 1.0 - min(cavity * 1.2 * uThickness, 0.1);
  // Canvas belongs to the support. Thick paint covers it; thin scumbles
  // reveal it. Keep this out of the height normal to avoid global embossing.
  // Do not shrink the weave below a pixel on small uploads.
  // Anchor grain to pixel centers so UV interpolation cannot change hash cells.
  vec2 cloth = (floor(vUv * uResolution) + 0.5) / max(scale, 1.0);
  float fiber = hash(floor(cloth * 0.48));
  vec2 weave = sin(cloth * 2.7 + (fiber - 0.5) * 0.65);
  float grain = hash(floor(cloth * 1.3)) - 0.5;
  float canvas = (weave.x * weave.y) * 0.009 + (fiber - 0.5) * 0.014 + grain * 0.012;
  float exposed = 1.0 - smoothstep(0.075, 0.15, paint.a);
  color += canvas * exposed;
  fragColor = vec4(mix(source, clamp(color, 0.0, 1.0), uStrength), 1.0);
}
