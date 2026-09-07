import { canvasToPngBlob, prepareImageBitmap } from "./image";
import type { ImageDimensions } from "./image";
import type { ImageProcessor } from "./processor";
import filterShader from "../shaders/painterly.glsl?raw";
import blendShader from "../shaders/blend.glsl?raw";

interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}
interface ImageResources {
  source: WebGLTexture;
  painted: RenderTarget;
  output: RenderTarget;
  dimensions: ImageDimensions;
  brush: number;
}

const vertexShader = `#version 300 es
out vec2 vUv;
uniform bool uFlipY;
void main() {
  vec2 uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(uv.x, uFlipY ? 1.0 - uv.y : uv.y);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;
const presentShader = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
void main() { fragColor = texture(uSource, vUv); }
`;

export function createWebGlProcessor(
  canvas: HTMLCanvasElement,
  onFatal: (error: Error) => void,
): ImageProcessor {
  const context = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!context) throw new Error("WebGL 2 is unavailable.");
  const gl = context;
  let disposed = false;
  let failure: Error | null = null;
  let current: ImageResources | null = null;
  let generation = 0;
  let passes = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const programs: WebGLProgram[] = [];
  const floatTargets = !!gl.getExtension("EXT_color_buffer_float");

  function healthy() {
    if (disposed) throw new Error("The image processor was closed.");
    if (failure) throw failure;
    if (gl.isContextLost())
      throw new Error("The graphics device was lost. Reload Lukis to continue.");
  }
  function check() {
    healthy();
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      throw new Error("The browser could not process this image. Try a smaller image.");
  }
  function onContextLost() {
    if (disposed || failure) return;
    failure = new Error("The graphics device was lost. Reload Lukis to continue.");
    onFatal(failure);
  }
  canvas.addEventListener("webglcontextlost", onContextLost);

  function createProgram(source: string) {
    const result = gl.createProgram();
    if (!result) throw new Error("The browser could not create a shader program.");
    programs.push(result);
    for (const [type, code] of [
      [gl.VERTEX_SHADER, vertexShader],
      [gl.FRAGMENT_SHADER, source],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("The browser could not create a shader.");
      try {
        gl.shaderSource(shader, code);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed.");
        gl.attachShader(result, shader);
      } finally {
        gl.deleteShader(shader);
      }
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(result) || "Shader linking failed.");
    return result;
  }
  function texture(linear = false) {
    const result = gl.createTexture();
    if (!result) throw new Error("The browser could not allocate an image texture.");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, result);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return result;
  }
  function target(size: ImageDimensions, float: boolean): RenderTarget {
    const color = texture();
    const framebuffer = gl.createFramebuffer();
    try {
      if (!framebuffer) throw new Error("The browser could not allocate an image target.");
      gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, size.width, size.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("The browser could not prepare the image target.");
      check();
      return { texture: color, framebuffer };
    } catch (error) {
      gl.deleteTexture(color);
      gl.deleteFramebuffer(framebuffer);
      throw error;
    }
  }
  function releaseTarget(value: RenderTarget | undefined) {
    if (!value) return;
    gl.deleteTexture(value.texture);
    gl.deleteFramebuffer(value.framebuffer);
  }
  function release(image: ImageResources | null) {
    if (!image) return;
    gl.deleteTexture(image.source);
    releaseTarget(image.painted);
    releaseTarget(image.output);
  }
  function bind(program: WebGLProgram, name: string, image: WebGLTexture, unit: number) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, image);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  }
  function enqueue<T>(action: () => T | Promise<T>): Promise<T> {
    const next = pending.then(() => {
      healthy();
      return action();
    });
    pending = next.catch(() => {});
    return next;
  }

  try {
    const filter = createProgram(filterShader);
    const blend = createProgram(blendShader);
    const present = createProgram(presentShader);
    // Dithering can change cached RGB values before the final blend.
    gl.disable(gl.DITHER);

    function draw(image: ImageResources, strength: number, brush: number) {
      healthy();
      gl.viewport(0, 0, image.dimensions.width, image.dimensions.height);
      if (image.brush !== brush) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, image.painted.framebuffer);
        gl.useProgram(filter);
        bind(filter, "uSource", image.source, 0);
        gl.uniform2f(
          gl.getUniformLocation(filter, "uResolution"),
          image.dimensions.width,
          image.dimensions.height,
        );
        gl.uniform1f(gl.getUniformLocation(filter, "uBrush"), brush);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        check();
        image.brush = brush;
        passes++;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, image.output.framebuffer);
      gl.useProgram(blend);
      bind(blend, "uSource", image.source, 0);
      bind(blend, "uPainted", image.painted.texture, 1);
      gl.uniform1f(gl.getUniformLocation(blend, "uStrength"), strength);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      check();
    }
    function show(image: ImageResources) {
      const { width, height } = image.dimensions;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(present);
      bind(present, "uSource", image.output.texture, 0);
      // ImageBitmap's first row stays first in the offscreen targets and readback.
      // Only presentation flips it into WebGL's bottom-left canvas coordinates.
      gl.uniform1i(gl.getUniformLocation(present, "uFlipY"), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      check();
    }
    function readCanvas(image: ImageResources, output: HTMLCanvasElement) {
      const { width, height } = image.dimensions;
      const bytes = new Uint8ClampedArray(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, image.output.framebuffer);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      check();
      output.width = width;
      output.height = height;
      const outputContext = output.getContext("2d");
      if (!outputContext) throw new Error("The browser could not prepare the image.");
      outputContext.putImageData(new ImageData(bytes, width, height), 0, 0);
    }
    async function png() {
      if (!current) throw new Error("There is no image to export.");
      const output = document.createElement("canvas");
      readCanvas(current, output);
      const result = await canvasToPngBlob(output);
      healthy();
      return result;
    }
    return {
      get filterPasses() {
        return passes;
      },
      async load(file, isCurrent, strength, brush) {
        const request = ++generation;
        const { bitmap, dimensions } = await prepareImageBitmap(file);
        try {
          return await enqueue(() => {
            if (!isCurrent() || request !== generation) return null;
            let source: WebGLTexture | undefined;
            let painted: RenderTarget | undefined;
            let output: RenderTarget | undefined;
            let committed = false;
            let presentationStarted = false;
            try {
              source = texture(true);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
              check();
              painted = target(dimensions, floatTargets);
              output = target(dimensions, false);
              const candidate = { source, painted, output, dimensions, brush: NaN };
              draw(candidate, strength, brush);
              if (!isCurrent() || request !== generation) return null;
              presentationStarted = true;
              show(candidate);
              const old = current;
              current = candidate;
              committed = true;
              release(old);
              return dimensions;
            } finally {
              if (!committed) {
                if (source) gl.deleteTexture(source);
                releaseTarget(painted);
                releaseTarget(output);
                if (presentationStarted && current) show(current);
              }
            }
          });
        } finally {
          bitmap.close();
        }
      },
      render(strength, brush) {
        return enqueue(() => {
          if (current) {
            draw(current, strength, brush);
            show(current);
          }
        });
      },
      snapshot(output) {
        return enqueue(() => {
          if (current) readCanvas(current, output);
        });
      },
      exportPng() {
        return enqueue(png);
      },
      download(filename) {
        return enqueue(async () => {
          const blob = await png();
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${filename}-lukis.png`;
          try {
            link.click();
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        });
      },
      clear() {
        generation++;
        void enqueue(() => {
          release(current);
          current = null;
        }).catch(() => {});
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        release(current);
        current = null;
        canvas.removeEventListener("webglcontextlost", onContextLost);
        for (const value of programs) gl.deleteProgram(value);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      },
    };
  } catch (error) {
    disposed = true;
    canvas.removeEventListener("webglcontextlost", onContextLost);
    for (const value of programs) gl.deleteProgram(value);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    throw error;
  }
}
