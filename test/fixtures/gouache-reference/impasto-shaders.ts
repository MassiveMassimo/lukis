// Knife marks carry color and surface height together. Lighting reads that
// surface in a separate pass, so ridges belong to strokes, not image edges.
export const knifeSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPaint;
uniform sampler2D uFlow;
uniform vec2 uResolution;
uniform float uBrushSize;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
}

void main() {
  vec2 pixel = vUv * uResolution;
  float scale = max(uResolution.x, uResolution.y) / 1000.0;
  vec3 baseColor = texture(uPaint, vUv).rgb;
  vec3 color = baseColor;
  float height = 0.06;
  // Thin, broad scumbles leave the Kuwahara shapes visible. Loaded knife
  // marks gather in patches above them, with exposed canvas in between.
  for (int layer = 0; layer < 2; layer++) {
    float cellSize = 11.0 * uBrushSize * scale * (layer == 0 ? 2.3 : 1.0);
    vec2 cell = floor(pixel / cellSize);
    float best = -1.0;
    vec3 coatColor = color;
    float coatHeight = height;
    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        vec2 id = cell + vec2(float(x), float(y));
        vec2 seed = id + float(layer) * 173.0;
        float order = hash(seed + 5.7);
        if (order < best) continue;
        vec2 center = (id + 0.5 + 0.78 *
          (vec2(hash(seed), hash(seed + 19.3)) - 0.5)) * cellSize;
        vec2 uv = clamp(center / uResolution, vec2(0.0), vec2(1.0));
        vec3 flow = texture(uFlow, uv).rgb;
        vec2 direction = flow.rg * 2.0 - 1.0;
        float confidence = smoothstep(0.005, 0.06, flow.b);
        vec2 probe = vec2(cellSize * 0.6) / uResolution;
        float variation = length(texture(uPaint, uv + vec2(probe.x, 0)).rgb -
                                 texture(uPaint, uv - vec2(probe.x, 0)).rgb) +
                          length(texture(uPaint, uv + vec2(0, probe.y)).rgb -
                                 texture(uPaint, uv - vec2(0, probe.y)).rgb);
        float activity = smoothstep(0.03, 0.25, variation);
        if (layer == 1 && activity < 0.12) continue;
        float loading = noise(center / (scale * 92.0) + 23.0);
        if (layer == 1 && hash(seed + 137.0) > mix(0.18, 0.88, loading)) continue;
        float angle = 0.5 * atan(direction.y, direction.x) + 1.5707963;
        angle = mix(-0.1, angle, confidence) + (hash(seed + 8.1) - 0.5) * mix(0.3, 1.4, activity);
        vec2 along = vec2(cos(angle), sin(angle));
        vec2 across = vec2(-along.y, along.x);
        vec2 delta = pixel - center;
        vec2 p = vec2(dot(delta, along), dot(delta, across)) / cellSize;
        // Broader length variation mixes short dabs with longer pulls. Keep
        // the whole curved footprint inside the 5x5 candidate neighborhood.
        float halfLength = mix(0.6, 1.5, hash(seed + 42.0));
        float halfWidth = mix(0.35, 0.64, hash(seed + 71.0));
        float bend = (hash(seed + 113.0) - 0.5) * mix(0.12, 0.65, activity);
        float progress = p.x / halfLength;
        // Bend the stroke's local coordinates so the silhouette, scrape
        // tracks, and height surface all follow the same gentle curve.
        p.y -= bend * (progress * progress - 0.3);
        float chips = noise(vec2(p.y * 7.0, order * 31.0));
        float end = halfLength - 0.16 * chips - 0.12 * p.y;
        float side = halfWidth * (1.0 - 0.12 * p.x) +
          0.035 * sin(p.x * 9.0 + order * 40.0);
        float edge = min(end - abs(p.x), side - abs(p.y));
        float coverage = smoothstep(0.0, 1.1 * scale / cellSize, edge);
        // Broken edges expose the same lower layer in both color and height.
        // Stretch the gaps along the pull to avoid a uniform speckled overlay.
        float tooth = noise(vec2(p.x * 3.0, p.y * 19.0) + seed);
        float dryEdge = (1.0 - smoothstep(0.0, 0.2, edge)) * 0.55;
        coverage *= smoothstep(dryEdge, dryEdge + 0.18, tooth);
        coverage *= layer == 0 ? 0.38 : 1.0;
        if (coverage <= 0.0) continue;
        vec3 ink = texture(uPaint, uv).rgb;
        // Keep thin features from being painted over by a distant color.
        float mismatch = length(ink - baseColor);
        if (mismatch > mix(0.3, 0.2, activity)) continue;
        // Uneven scrape tracks. A periodic sine makes every mark look like
        // corrugated plastic; irregular spacing and pressure leave flat paint.
        float groove = p.y * cellSize / (1.7 * scale) +
          0.12 * p.x * p.x + order * 43.0;
        float ridge = pow(noise(vec2(groove, order * 61.0)), 3.0);
        ridge *= mix(0.3, 1.0, hash(seed + 91.0));
        float rim = exp(-max(edge, 0.0) * cellSize / (1.8 * scale));
        float body = smoothstep(0.0, 2.5 * scale / cellSize, edge);
        float pressure = 0.85 + 0.15 * p.x / halfLength;
        float relief = (0.10 + order * 0.04 + ridge * 0.24 + rim * 0.035) * body * pressure;
        relief *= mix(0.07, 1.0, activity);
        relief *= layer == 0 ? 0.18 : 1.0;
        ink += (hash(seed + 15.0) - 0.5) * mix(0.008, 0.035, activity);
        vec2 colorOffset = along * halfLength * 0.6 * cellSize / uResolution;
        vec2 bendOffset = across * bend * 0.06 * cellSize / uResolution;
        vec3 startInk = texture(uPaint, clamp(uv - colorOffset + bendOffset,
          vec2(0.0), vec2(1.0))).rgb;
        vec3 endInk = texture(uPaint, clamp(uv + colorOffset + bendOffset,
          vec2(0.0), vec2(1.0))).rgb;
        vec3 dragged = mix(startInk, endInk, smoothstep(-0.85, 0.85, progress));
        // A restrained color pull retains the opaque stroke and prevents
        // samples across a strong image edge from washing out its color.
        ink += clamp(dragged - ink, vec3(-0.16), vec3(0.16)) * 0.35;
        ink += (ridge - 0.15) * 0.014 * activity;
        coatColor = mix(color, ink, coverage);
        coatHeight = mix(height, 0.06 + relief, coverage);
        best = order;
      }
    }
    color = coatColor;
    height = coatHeight;
  }
  fragColor = vec4(clamp(color, 0.0, 1.0), height);
}`;

export const impastoLightSource = `#version 300 es
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
  // Normalize rasterization noise for the cross-API shader comparison.
  vec2 cloth = (floor(vUv * uResolution) + 0.5) / max(scale, 1.0);
  float fiber = hash(floor(cloth * 0.48));
  vec2 weave = sin(cloth * 2.7 + (fiber - 0.5) * 0.65);
  float grain = hash(floor(cloth * 1.3)) - 0.5;
  float canvas = (weave.x * weave.y) * 0.009 + (fiber - 0.5) * 0.014 + grain * 0.012;
  float exposed = 1.0 - smoothstep(0.075, 0.15, paint.a);
  color += canvas * exposed;
  fragColor = vec4(mix(source, clamp(color, 0.0, 1.0), uStrength), 1.0);
}`;
