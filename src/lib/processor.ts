import { effect, frame, init, sampler, surface, target } from "vgpu";
import type { Gpu, Surface, Target, Texture } from "vgpu";
import { canvasToPngBlob, prepareImageBitmap } from "./image";
import type { ImageDimensions } from "./image";
import filterShader from "../shaders/painterly.wgsl?raw";
import blendShader from "../shaders/blend.wgsl?raw";

export const WEBGPU_REQUIRED =
  "Lukis needs WebGPU. Open it in a browser with WebGPU enabled on a supported device.";

interface ImageResources {
  source: Texture;
  painted: Target;
  output: Target;
  dimensions: ImageDimensions;
  brush: number;
}

function release(image: ImageResources | null) {
  image?.source.destroy();
  image?.painted.color.destroy();
  image?.output.color.destroy();
}

export interface ImageProcessor {
  load(
    file: Blob,
    isCurrent: () => boolean,
    strength: number,
    brush: number,
  ): Promise<ImageDimensions | null>;
  render(strength: number, brush: number): Promise<void>;
  snapshot(canvas: HTMLCanvasElement): Promise<void>;
  download(filename: string): Promise<void>;
  clear(): void;
  dispose(): void;
  readonly filterPasses: number;
}

export async function createImageProcessor(
  canvas: HTMLCanvasElement,
  onFatal: (error: Error) => void = () => {},
): Promise<ImageProcessor> {
  let gpu: Gpu;
  try {
    gpu = await init();
  } catch {
    throw new Error(WEBGPU_REQUIRED);
  }
  let disposed = false;
  let failure: Error | null = null;
  let current: ImageResources | null = null;
  let canvasSurface: Surface | null = null;
  let passes = 0;
  let generation = 0;
  let pending: Promise<unknown> = Promise.resolve();

  function fail(error: Error) {
    if (disposed || failure) return;
    failure = error;
    onFatal(error);
  }
  gpu.onError((error) => fail(error));
  const onGpuError = (event: GPUUncapturedErrorEvent) => fail(new Error(event.error.message));
  gpu.gpu.addEventListener("uncapturederror", onGpuError);
  void gpu.gpu.lost.then((info) => {
    if (!disposed)
      fail(new Error(`The graphics device was lost. Reload Lukis to continue. ${info.message}`));
  });
  const imageSampler = sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const filter = effect(gpu, filterShader);
  const blend = effect(gpu, blendShader);
  const present = effect(
    gpu,
    `
    @group(0) @binding(0) var image: texture_2d<f32>;
    @group(0) @binding(1) var imageSampler: sampler;
    @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return textureSampleLevel(image, imageSampler, uv, 0.0);
    }
  `,
  );

  function healthy() {
    if (disposed) throw new Error("The image processor was closed.");
    if (failure) throw failure;
  }
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(() => {
      healthy();
      return action();
    });
    pending = next.catch(() => {});
    return next;
  }
  async function checked(action: () => Promise<void>) {
    gpu.gpu.pushErrorScope("validation");
    let actionError: Error | undefined;
    try {
      await action();
      await gpu.settled();
    } catch (cause) {
      actionError = cause instanceof Error ? cause : new Error(String(cause));
    }
    const error = await gpu.gpu.popErrorScope();
    if (actionError) throw actionError;
    if (error) throw new Error(error.message);
    healthy();
  }
  async function show(image: ImageResources) {
    const size = [image.dimensions.width, image.dimensions.height] as const;
    await checked(async () => {
      if (!canvasSurface)
        canvasSurface = surface(gpu, canvas, {
          size,
          autoResize: false,
          alphaMode: "opaque",
          colorSpace: "srgb",
        });
      else canvasSurface.resize(size);
      present.set({ image: image.output.color, imageSampler });
      await frame(gpu, (f) => f.pass(canvasSurface!, present)).done;
    });
  }
  async function draw(image: ImageResources, strength: number, brush: number, visible: boolean) {
    healthy();
    const settings = {
      resolution: [image.dimensions.width, image.dimensions.height],
      strength,
      brush,
    };
    const needsFilter = image.brush !== brush;
    await checked(async () => {
      filter.set({ source: image.source, imageSampler, settings });
      blend.set({ source: image.source, painted: image.painted.color, imageSampler, settings });
      const rendered = frame(gpu, (f) => {
        if (needsFilter) f.pass(image.painted, filter);
        f.pass(image.output, blend);
        if (visible && canvasSurface) {
          present.set({ image: image.output.color, imageSampler });
          f.pass(canvasSurface, present);
        }
      });
      await rendered.done;
    });
    if (needsFilter) {
      image.brush = brush;
      passes++;
    }
  }
  async function readCanvas(image: ImageResources, output: HTMLCanvasElement) {
    const bytes = await image.output.read();
    healthy();
    output.width = image.dimensions.width;
    output.height = image.dimensions.height;
    const context = output.getContext("2d");
    if (!context) throw new Error("The browser could not prepare the image.");
    context.putImageData(
      new ImageData(new Uint8ClampedArray(bytes), output.width, output.height),
      0,
      0,
    );
  }

  return {
    get filterPasses() {
      return passes;
    },
    async load(file, isCurrent, strength, brush) {
      const request = ++generation;
      const prepared = await prepareImageBitmap(file);
      try {
        return await enqueue(async () => {
          if (!isCurrent() || request !== generation) return null;
          const { bitmap, dimensions } = prepared;
          const size = [dimensions.width, dimensions.height] as const;
          let source: Texture | undefined;
          let painted: Target | undefined;
          let output: Target | undefined;
          let committed = false;
          let presentationStarted = false;
          try {
            await checked(async () => {
              source = gpu.device.createTexture({
                size,
                format: "rgba8unorm",
                usage: ["texture_binding", "copy_dst", "render_attachment"],
              });
              painted = target(gpu, { size, format: "rgba16float" });
              output = target(gpu, { size, format: "rgba8unorm" });
              gpu.gpu.queue.copyExternalImageToTexture(
                { source: bitmap, flipY: false },
                // Match the reference ImageBitmap upload before producing opaque RGB.
                { texture: source.gpu, colorSpace: "srgb", premultipliedAlpha: true },
                size,
              );
              await gpu.gpu.queue.onSubmittedWorkDone();
            });
            const candidate: ImageResources = {
              source: source!,
              painted: painted!,
              output: output!,
              dimensions,
              brush: NaN,
            };
            await draw(candidate, strength, brush, false);
            if (!isCurrent() || request !== generation) return null;
            presentationStarted = true;
            await show(candidate);
            if (!isCurrent() || request !== generation) return null;
            const old = current;
            current = candidate;
            committed = true;
            release(old);
            return dimensions;
          } finally {
            if (!committed) {
              source?.destroy();
              painted?.color.destroy();
              output?.color.destroy();
              if (presentationStarted && !disposed && !failure) {
                if (current) await show(current);
                else {
                  canvasSurface?.dispose();
                  canvasSurface = null;
                  canvas.width = canvas.height = 0;
                }
              }
            }
          }
        });
      } finally {
        prepared.bitmap.close();
      }
    },
    render(strength, brush) {
      return enqueue(async () => {
        if (current) await draw(current, strength, brush, true);
      });
    },
    snapshot(output) {
      return enqueue(async () => {
        if (current) await readCanvas(current, output);
      });
    },
    download(filename) {
      return enqueue(async () => {
        if (!current) return;
        const output = document.createElement("canvas");
        await readCanvas(current, output);
        const blob = await canvasToPngBlob(output);
        healthy();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${filename}-lukis.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    },
    clear() {
      generation++;
      void enqueue(async () => {
        release(current);
        current = null;
      }).catch(() => {});
    },
    dispose() {
      disposed = true;
      generation++;
      release(current);
      current = null;
      canvasSurface?.dispose();
      gpu.gpu.removeEventListener("uncapturederror", onGpuError);
      gpu.dispose();
    },
  };
}
