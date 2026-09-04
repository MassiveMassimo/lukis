const PAPARI_RADIUS = 3;
const SECTOR_COUNT = 8;
export const MAX_OUTPUT_DIMENSION = 1600;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface PreparedImageBitmap {
  bitmap: ImageBitmap;
  dimensions: ImageDimensions;
}

export type ImageBitmapFactory = typeof createImageBitmap;

export interface PainterlyProcessor {
  dispose: () => void;
  download: (filename: string) => Promise<void>;
  load: (file: Blob, isCurrent?: () => boolean) => Promise<ImageDimensions | null>;
  render: (strength: number, brushSize: number) => void;
}

const vertexSource = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  vec2 positionUv = aPosition * 0.5 + 0.5;
  vUv = vec2(positionUv.x, 1.0 - positionUv.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;

const int PAPARI_RADIUS = ${PAPARI_RADIUS};
const int SECTOR_COUNT = ${SECTOR_COUNT};

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uBrushSize;

vec3 sampleColor(vec2 offset) {
  vec2 coord = clamp(vUv + offset * uBrushSize / uResolution, vec2(0.0), vec2(1.0));
  return texture(uImage, coord).rgb;
}

float polynomialWeight(float x, float y, float eta, float lambda) {
  float polyValue = (x + eta) - lambda * (y * y);
  return max(0.0, polyValue * polyValue);
}

void getSectorVarianceAndAverageColor(
  float angle,
  out vec3 averageColor,
  out float variance
) {
  vec3 weightedColorSum = vec3(0.0);
  vec3 weightedSquaredColorSum = vec3(0.0);
  float totalWeight = 0.0;
  float eta = 0.1;
  float lambda = 0.5;

  for (int radius = 1; radius <= PAPARI_RADIUS; radius++) {
    for (int angleStep = 0; angleStep < 5; angleStep++) {
      float angleOffset = -0.392699 + float(angleStep) * 0.196349;
      vec2 sampleOffset =
        float(radius) * vec2(cos(angle + angleOffset), sin(angle + angleOffset));
      vec3 color = sampleColor(sampleOffset);
      float weight =
        polynomialWeight(sampleOffset.x, sampleOffset.y, eta, lambda);

      weightedColorSum += color * weight;
      weightedSquaredColorSum += color * color * weight;
      totalWeight += weight;
    }
  }

  float safeTotalWeight = max(totalWeight, 0.0001);
  averageColor = weightedColorSum / safeTotalWeight;
  vec3 varianceResult =
    weightedSquaredColorSum / safeTotalWeight - averageColor * averageColor;
  variance = dot(varianceResult, vec3(0.299, 0.587, 0.114));
}

void main() {
  float minimumVariance = 1e20;
  vec3 paintedColor = vec3(0.0);

  for (int sector = 0; sector < SECTOR_COUNT; sector++) {
    float angle = float(sector) * 6.2831853 / float(SECTOR_COUNT);
    vec3 sectorColor;
    float sectorVariance;

    getSectorVarianceAndAverageColor(angle, sectorColor, sectorVariance);
    if (sectorVariance < minimumVariance) {
      minimumVariance = sectorVariance;
      paintedColor = sectorColor;
    }
  }

  vec3 sourceColor = texture(uImage, vUv).rgb;
  fragColor = vec4(mix(sourceColor, paintedColor, uStrength), 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("The browser could not create a shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Shader compilation failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("The browser could not create a shader program.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Shader linking failed.";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

function createImageTexture(gl: WebGL2RenderingContext, bitmap: ImageBitmap): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("The browser could not allocate an image texture.");
  }

  try {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

export function outputDimensions(width: number, height: number): ImageDimensions {
  const scale = Math.min(1, MAX_OUTPUT_DIMENSION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function prepareImageBitmap(
  file: Blob,
  createBitmap: ImageBitmapFactory = createImageBitmap,
): Promise<PreparedImageBitmap> {
  const sourceBitmap = await createBitmap(file);
  const dimensions = outputDimensions(sourceBitmap.width, sourceBitmap.height);

  if (dimensions.width === sourceBitmap.width && dimensions.height === sourceBitmap.height) {
    return { bitmap: sourceBitmap, dimensions };
  }

  try {
    const bitmap = await createBitmap(sourceBitmap, 0, 0, sourceBitmap.width, sourceBitmap.height, {
      resizeWidth: dimensions.width,
      resizeHeight: dimensions.height,
      resizeQuality: "high",
    });
    return { bitmap, dimensions };
  } finally {
    sourceBitmap.close();
  }
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("The browser could not create a PNG."));
    }, "image/png");
  });
}

export function createPainterlyProcessor(canvas: HTMLCanvasElement): PainterlyProcessor {
  const glContext = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  });

  if (!glContext) {
    throw new Error("This tool needs a browser with WebGL 2 support.");
  }

  const gl = glContext;
  const program = createProgram(gl);
  const positionLocation = gl.getAttribLocation(program, "aPosition");
  const resolutionLocation = gl.getUniformLocation(program, "uResolution");
  const strengthLocation = gl.getUniformLocation(program, "uStrength");
  const brushSizeLocation = gl.getUniformLocation(program, "uBrushSize");
  const imageLocation = gl.getUniformLocation(program, "uImage");
  const vertexArray = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  let imageTexture: WebGLTexture | null = null;

  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  async function load(
    file: Blob,
    isCurrent: () => boolean = () => true,
  ): Promise<ImageDimensions | null> {
    const { bitmap, dimensions } = await prepareImageBitmap(file);

    try {
      if (!isCurrent()) return null;

      const nextTexture = createImageTexture(gl, bitmap);

      if (!isCurrent()) {
        gl.deleteTexture(nextTexture);
        return null;
      }

      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      if (imageTexture) gl.deleteTexture(imageTexture);
      imageTexture = nextTexture;
      return dimensions;
    } finally {
      bitmap.close();
    }
  }

  function render(strength: number, brushSize: number): void {
    if (!imageTexture) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.uniform1i(imageLocation, 0);
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(strengthLocation, strength);
    gl.uniform1f(brushSizeLocation, brushSize);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  async function download(filename: string): Promise<void> {
    gl.finish();
    const blob = await canvasToPngBlob(canvas);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}-painterly.png`;

    try {
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  function dispose(): void {
    if (imageTexture) gl.deleteTexture(imageTexture);
    gl.deleteBuffer(positionBuffer);
    gl.deleteVertexArray(vertexArray);
    gl.deleteProgram(program);
  }

  return { dispose, download, load, render };
}
