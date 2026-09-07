import { canvasToPngBlob, prepareImageBitmap } from "./image";
import type { ImageDimensions } from "./image";
import type { ImageProcessor } from "./processor";
import filterShader from "../shaders/underpaint.glsl?raw";
import blendShader from "../shaders/impasto-light.glsl?raw";
import flowShader from "../shaders/flow.glsl?raw";
import knifeShader from "../shaders/knife.glsl?raw";

interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}
interface ImageResources {
  source: WebGLTexture;
  painted: RenderTarget;
  flow: RenderTarget;
  knife: RenderTarget;
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
  function target(size: ImageDimensions): RenderTarget {
    const color = texture(true);
    const framebuffer = gl.createFramebuffer();
    try {
      if (!framebuffer) throw new Error("The browser could not allocate an image target.");
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size.width, size.height);
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
    releaseTarget(image.flow);
    releaseTarget(image.knife);
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
    const flowPass = createProgram(flowShader);
    const knifePass = createProgram(knifeShader);
    const present = createProgram(presentShader);
    // Dithering can change cached RGB values before the final blend.
    gl.disable(gl.DITHER);

    function resolution(program: WebGLProgram, image: ImageResources) {
      gl.uniform2f(
        gl.getUniformLocation(program, "uResolution"),
        image.dimensions.width,
        image.dimensions.height,
      );
    }
    function draw(image: ImageResources, strength: number, brush: number, thickness: number) {
      healthy();
      if (Number.isNaN(image.brush)) {
        gl.viewport(
          0,
          0,
          Math.ceil(image.dimensions.width / 2),
          Math.ceil(image.dimensions.height / 2),
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, image.flow.framebuffer);
        gl.useProgram(flowPass);
        bind(flowPass, "uImage", image.source, 0);
        resolution(flowPass, image);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        check();
      }
      gl.viewport(0, 0, image.dimensions.width, image.dimensions.height);
      if (image.brush !== brush) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, image.painted.framebuffer);
        gl.useProgram(filter);
        bind(filter, "uImage", image.source, 0);
        bind(filter, "uFlow", image.flow.texture, 1);
        gl.uniform2f(
          gl.getUniformLocation(filter, "uResolution"),
          image.dimensions.width,
          image.dimensions.height,
        );
        gl.uniform1f(gl.getUniformLocation(filter, "uBrushSize"), brush);
        for (const [name, value] of Object.entries({
          uStrength: 1,
          uDirection: 0.85,
          uDetail: 0.6,
          uSoftness: 0.35,
          uPaper: 0,
          uPigment: 0.3,
          uColor: 0.35,
        })) {
          gl.uniform1f(gl.getUniformLocation(filter, name), value);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        check();
        gl.bindFramebuffer(gl.FRAMEBUFFER, image.knife.framebuffer);
        gl.useProgram(knifePass);
        bind(knifePass, "uPaint", image.painted.texture, 0);
        bind(knifePass, "uFlow", image.flow.texture, 1);
        resolution(knifePass, image);
        gl.uniform1f(gl.getUniformLocation(knifePass, "uBrushSize"), brush);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        check();
        image.brush = brush;
        passes++;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, image.output.framebuffer);
      gl.useProgram(blend);
      bind(blend, "uImage", image.source, 0);
      bind(blend, "uSurface", image.knife.texture, 1);
      resolution(blend, image);
      gl.uniform1f(gl.getUniformLocation(blend, "uStrength"), strength);
      gl.uniform1f(gl.getUniformLocation(blend, "uThickness"), thickness);
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
      async load(file, isCurrent, strength, brush, thickness = 0.65) {
        const request = ++generation;
        const { bitmap, dimensions } = await prepareImageBitmap(file);
        try {
          return await enqueue(() => {
            if (!isCurrent() || request !== generation) return null;
            let source: WebGLTexture | undefined;
            let painted: RenderTarget | undefined;
            let flow: RenderTarget | undefined;
            let knife: RenderTarget | undefined;
            let output: RenderTarget | undefined;
            let committed = false;
            let presentationStarted = false;
            try {
              source = texture(true);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
              check();
              flow = target({
                width: Math.ceil(dimensions.width / 2),
                height: Math.ceil(dimensions.height / 2),
              });
              painted = target(dimensions);
              knife = target(dimensions);
              output = target(dimensions);
              const candidate = { source, flow, painted, knife, output, dimensions, brush: NaN };
              draw(candidate, strength, brush, thickness);
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
                releaseTarget(flow);
                releaseTarget(knife);
                releaseTarget(output);
                if (presentationStarted && current) show(current);
              }
            }
          });
        } finally {
          bitmap.close();
        }
      },
      render(strength, brush, thickness = 0.65) {
        return enqueue(() => {
          if (current) {
            draw(current, strength, brush, thickness);
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
