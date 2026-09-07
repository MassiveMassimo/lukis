#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform sampler2D uPainted;
uniform float uStrength;

void main() {
  fragColor = vec4(mix(texture(uSource, vUv).rgb, texture(uPainted, vUv).rgb, uStrength), 1.0);
}
