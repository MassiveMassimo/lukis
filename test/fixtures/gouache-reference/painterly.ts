import { flowSource, fragmentSource, vertexSource } from "./painterly-shaders.ts";
import { impastoLightSource, knifeSource } from "./impasto-shaders.ts";

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

export const DEFAULT_PAINT_SETTINGS = {
  flow: 85,
  detail: 60,
  softness: 35,
  paper: 30,
  pigment: 30,
  color: 35,
  thickness: 65,
};

export type PaintSettings = typeof DEFAULT_PAINT_SETTINGS;

export interface PainterlyProcessor {
  dispose: () => void;
  download: (filename: string) => Promise<void>;
  load: (file: Blob, isCurrent?: () => boolean) => Promise<ImageDimensions | null>;
  render: (strength: number, brushSize: number, settings?: PaintSettings) => void;
}

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

function createProgram(gl: WebGL2RenderingContext, source: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("The browser could not create a shader program.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, source);

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
  const program = createProgram(gl, fragmentSource);
  const flowProgram = createProgram(gl, flowSource);
  const knifeProgram = createProgram(gl, knifeSource);
  const lightProgram = createProgram(gl, impastoLightSource);
  const knifeUniforms = {
    paint: gl.getUniformLocation(knifeProgram, "uPaint"),
    flow: gl.getUniformLocation(knifeProgram, "uFlow"),
    resolution: gl.getUniformLocation(knifeProgram, "uResolution"),
    brush: gl.getUniformLocation(knifeProgram, "uBrushSize"),
    flip: gl.getUniformLocation(knifeProgram, "uFlipY"),
  };
  const lightUniforms = {
    image: gl.getUniformLocation(lightProgram, "uImage"),
    surface: gl.getUniformLocation(lightProgram, "uSurface"),
    resolution: gl.getUniformLocation(lightProgram, "uResolution"),
    strength: gl.getUniformLocation(lightProgram, "uStrength"),
    thickness: gl.getUniformLocation(lightProgram, "uThickness"),
    flip: gl.getUniformLocation(lightProgram, "uFlipY"),
  };
  const resolutionLocation = gl.getUniformLocation(program, "uResolution");
  const strengthLocation = gl.getUniformLocation(program, "uStrength");
  const brushSizeLocation = gl.getUniformLocation(program, "uBrushSize");
  const imageLocation = gl.getUniformLocation(program, "uImage");
  const flowLocation = gl.getUniformLocation(program, "uFlow");
  const flipLocation = gl.getUniformLocation(program, "uFlipY");
  const flowResolutionLocation = gl.getUniformLocation(flowProgram, "uResolution");
  const flowImageLocation = gl.getUniformLocation(flowProgram, "uImage");
  const flowFlipLocation = gl.getUniformLocation(flowProgram, "uFlipY");
  const settingsLocations = {
    flow: gl.getUniformLocation(program, "uDirection"),
    detail: gl.getUniformLocation(program, "uDetail"),
    softness: gl.getUniformLocation(program, "uSoftness"),
    paper: gl.getUniformLocation(program, "uPaper"),
    pigment: gl.getUniformLocation(program, "uPigment"),
    color: gl.getUniformLocation(program, "uColor"),
  };
  const vertexArray = gl.createVertexArray();
  const positionBuffer = gl.createBuffer();
  let imageTexture: WebGLTexture | null = null;
  const flowTexture = gl.createTexture();
  const flowFramebuffer = gl.createFramebuffer();
  const paintTexture = gl.createTexture();
  const surfaceTexture = gl.createTexture();
  const paintFramebuffer = gl.createFramebuffer();
  const surfaceFramebuffer = gl.createFramebuffer();
  let cachedSurfaceKey = "";

  if (
    !flowTexture ||
    !flowFramebuffer ||
    !paintTexture ||
    !surfaceTexture ||
    !paintFramebuffer ||
    !surfaceFramebuffer
  ) {
    gl.deleteTexture(flowTexture);
    gl.deleteFramebuffer(flowFramebuffer);
    gl.deleteProgram(program);
    gl.deleteProgram(flowProgram);
    gl.deleteProgram(knifeProgram);
    gl.deleteProgram(lightProgram);
    gl.deleteTexture(paintTexture);
    gl.deleteTexture(surfaceTexture);
    gl.deleteFramebuffer(paintFramebuffer);
    gl.deleteFramebuffer(surfaceFramebuffer);
    gl.deleteVertexArray(vertexArray);
    gl.deleteBuffer(positionBuffer);
    throw new Error("The browser could not allocate the brush direction map.");
  }

  gl.bindTexture(gl.TEXTURE_2D, flowTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function sizeSurface(
    texture: WebGLTexture,
    framebuffer: WebGLFramebuffer,
    dimensions: ImageDimensions,
  ): void {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      dimensions.width,
      dimensions.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (!complete) throw new Error("The browser could not prepare the paint surface.");
  }

  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function prepareFlow(texture: WebGLTexture, dimensions: ImageDimensions): void {
    const width = Math.max(1, Math.ceil(dimensions.width / 2));
    const height = Math.max(1, Math.ceil(dimensions.height / 2));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, flowTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, flowFramebuffer);
    try {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, flowTexture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("The browser could not prepare the brush direction map.");
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(flowProgram);
      gl.bindVertexArray(vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(flowImageLocation, 0);
      gl.uniform1i(flowFlipLocation, 0);
      gl.uniform2f(flowResolutionLocation, dimensions.width, dimensions.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  async function load(
    file: Blob,
    isCurrent: () => boolean = () => true,
  ): Promise<ImageDimensions | null> {
    const { bitmap, dimensions } = await prepareImageBitmap(file);

    try {
      if (!isCurrent()) return null;

      const nextTexture = createImageTexture(gl, bitmap);

      try {
        prepareFlow(nextTexture, dimensions);
        sizeSurface(paintTexture, paintFramebuffer, dimensions);
        sizeSurface(surfaceTexture, surfaceFramebuffer, dimensions);
      } catch (error) {
        gl.deleteTexture(nextTexture);
        throw error;
      }

      if (!isCurrent()) {
        gl.deleteTexture(nextTexture);
        return null;
      }

      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      if (imageTexture) gl.deleteTexture(imageTexture);
      imageTexture = nextTexture;
      cachedSurfaceKey = "";
      return dimensions;
    } finally {
      bitmap.close();
    }
  }

  function render(
    strength: number,
    brushSize: number,
    settings: PaintSettings = DEFAULT_PAINT_SETTINGS,
  ): void {
    if (!imageTexture) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    const surfaceKey = JSON.stringify([
      brushSize,
      settings.flow,
      settings.detail,
      settings.softness,
      settings.pigment,
      settings.color,
    ]);
    if (strength > 0 && cachedSurfaceKey !== surfaceKey) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, paintFramebuffer);
      gl.useProgram(program);
      gl.bindVertexArray(vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      gl.uniform1i(imageLocation, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, flowTexture);
      gl.uniform1i(flowLocation, 1);
      gl.uniform1i(flipLocation, 0);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(strengthLocation, 1);
      gl.uniform1f(brushSizeLocation, brushSize);
      for (const key of Object.keys(settingsLocations) as (keyof typeof settingsLocations)[]) {
        gl.uniform1f(settingsLocations[key], key === "paper" ? 0 : settings[key] / 100);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, surfaceFramebuffer);
      gl.useProgram(knifeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, paintTexture);
      gl.uniform1i(knifeUniforms.paint, 0);
      gl.uniform1i(knifeUniforms.flow, 1);
      gl.uniform1i(knifeUniforms.flip, 0);
      gl.uniform2f(knifeUniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(knifeUniforms.brush, brushSize);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      cachedSurfaceKey = surfaceKey;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(lightProgram);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, surfaceTexture);
    gl.uniform1i(lightUniforms.image, 0);
    gl.uniform1i(lightUniforms.surface, 2);
    gl.uniform1i(lightUniforms.flip, 1);
    gl.uniform2f(lightUniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(lightUniforms.strength, strength);
    gl.uniform1f(lightUniforms.thickness, settings.thickness / 100);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Unbind the surface before the next render writes into it.
    gl.bindTexture(gl.TEXTURE_2D, null);
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
    gl.deleteProgram(flowProgram);
    gl.deleteTexture(flowTexture);
    gl.deleteFramebuffer(flowFramebuffer);
    gl.deleteProgram(knifeProgram);
    gl.deleteProgram(lightProgram);
    gl.deleteTexture(paintTexture);
    gl.deleteTexture(surfaceTexture);
    gl.deleteFramebuffer(paintFramebuffer);
    gl.deleteFramebuffer(surfaceFramebuffer);
  }

  return { dispose, download, load, render };
}
