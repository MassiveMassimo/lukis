import { effect, frame, init, sampler, surface, target } from "vgpu";
import type { Gpu, Surface, Target, Texture } from "vgpu";
import { canvasToPngBlob, prepareImageBitmap } from "./image";
import type { ImageDimensions } from "./image";
import type { ImageProcessor } from "./processor";
import filterShader from "../shaders/underpaint.wgsl?raw";
import blendShader from "../shaders/impasto-light.wgsl?raw";
import flowShader from "../shaders/flow.wgsl?raw";
import knifeShader from "../shaders/knife.wgsl?raw";

interface ImageResources {
  source: Texture;
  painted: Target;
  flow: Target;
  knife: Target;
  output: Target;
  dimensions: ImageDimensions;
  brush: number;
}

function release(image: ImageResources | null) {
  image?.source.destroy();
  image?.painted.color.destroy();
  image?.flow.color.destroy();
  image?.knife.color.destroy();
  image?.output.color.destroy();
}

export async function createWebGpuProcessor(
  canvas: HTMLCanvasElement,
  onFatal: (error: Error) => void = () => {},
): Promise<ImageProcessor> {
  const gpu: Gpu = await init();
  let disposed = false;
  let initialized = false;
  let failure: Error | null = null;
  let current: ImageResources | null = null;
  let canvasSurface: Surface | null = null;
  let passes = 0;
  let generation = 0;
  let pending: Promise<unknown> = Promise.resolve();

  function fail(error: Error) {
    if (disposed || failure) return;
    failure = error;
    if (initialized) onFatal(error);
  }
  gpu.onError((error) => fail(error));
  const onGpuError = (event: GPUUncapturedErrorEvent) => fail(new Error(event.error.message));
  gpu.gpu.addEventListener("uncapturederror", onGpuError);
  void gpu.gpu.lost.then((info) => {
    if (!disposed)
      fail(new Error(`The graphics device was lost. Reload Lukis to continue. ${info.message}`));
  });
  try {
    const imageSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const filter = effect(gpu, filterShader);
    const blend = effect(gpu, blendShader);
    const flowPass = effect(gpu, flowShader);
    const knifePass = effect(gpu, knifeShader);
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
    async function png(): Promise<Blob> {
      if (!current) throw new Error("There is no image to export.");
      const output = document.createElement("canvas");
      await readCanvas(current, output);
      const blob = await canvasToPngBlob(output);
      healthy();
      return blob;
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
    async function draw(
      image: ImageResources,
      strength: number,
      brush: number,
      thickness: number,
      visible: boolean,
    ) {
      healthy();
      const settings = {
        resolution: [image.dimensions.width, image.dimensions.height],
        strength,
        brush,
        thickness,
      };
      const needsFilter = image.brush !== brush;
      await checked(async () => {
        flowPass.set({ source: image.source, imageSampler, settings });
        filter.set({ source: image.source, flow: image.flow.color, imageSampler, settings });
        knifePass.set({
          paint: image.painted.color,
          flow: image.flow.color,
          imageSampler,
          settings,
        });
        blend.set({ source: image.source, painted: image.knife.color, imageSampler, settings });
        const rendered = frame(gpu, (f) => {
          if (Number.isNaN(image.brush)) f.pass(image.flow, flowPass);
          if (needsFilter) {
            f.pass(image.painted, filter);
            f.pass(image.knife, knifePass);
          }
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

    // Compile and execute before binding the visible canvas, so startup failures
    // can fall back without replacing any DOM nodes or showing error chrome.
    let probeSource: Texture | undefined;
    let probePainted: Target | undefined;
    let probeFlow: Target | undefined;
    let probeKnife: Target | undefined;
    let probeOutput: Target | undefined;
    let probeSurface: Surface | undefined;
    try {
      probeSource = gpu.device.createTexture({
        size: [1, 1],
        format: "rgba8unorm",
        usage: ["texture_binding"],
      });
      probePainted = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      probeFlow = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      probeKnife = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      probeOutput = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      await draw(
        {
          source: probeSource,
          painted: probePainted,
          flow: probeFlow,
          knife: probeKnife,
          output: probeOutput,
          dimensions: { width: 1, height: 1 },
          brush: NaN,
        },
        0.5,
        1,
        0.65,
        false,
      );
      await checked(async () => {
        probeSurface = surface(gpu, document.createElement("canvas"), {
          size: [1, 1],
          autoResize: false,
          alphaMode: "opaque",
          colorSpace: "srgb",
        });
        present.set({ image: probeOutput!.color, imageSampler });
        await frame(gpu, (f) => f.pass(probeSurface!, present)).done;
      });
      passes = 0;
    } finally {
      probeSurface?.dispose();
      probeSource?.destroy();
      probePainted?.color.destroy();
      probeFlow?.color.destroy();
      probeKnife?.color.destroy();
      probeOutput?.color.destroy();
    }
    initialized = true;
    return {
      get filterPasses() {
        return passes;
      },
      async load(file, isCurrent, strength, brush, thickness = 0.65) {
        const request = ++generation;
        const prepared = await prepareImageBitmap(file);
        try {
          return await enqueue(async () => {
            if (!isCurrent() || request !== generation) return null;
            const { bitmap, dimensions } = prepared;
            const size = [dimensions.width, dimensions.height] as const;
            let source: Texture | undefined;
            let painted: Target | undefined;
            let flow: Target | undefined;
            let knife: Target | undefined;
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
                painted = target(gpu, { size, format: "rgba8unorm" });
                flow = target(gpu, {
                  size: [Math.ceil(dimensions.width / 2), Math.ceil(dimensions.height / 2)],
                  format: "rgba8unorm",
                });
                knife = target(gpu, { size, format: "rgba8unorm" });
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
                flow: flow!,
                knife: knife!,
                output: output!,
                dimensions,
                brush: NaN,
              };
              await draw(candidate, strength, brush, thickness, false);
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
                flow?.color.destroy();
                knife?.color.destroy();
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
      render(strength, brush, thickness = 0.65) {
        return enqueue(async () => {
          if (current) await draw(current, strength, brush, thickness, true);
        });
      },
      snapshot(output) {
        return enqueue(async () => {
          if (current) await readCanvas(current, output);
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
  } catch (error) {
    disposed = true;
    gpu.gpu.removeEventListener("uncapturederror", onGpuError);
    gpu.dispose();
    throw error;
  }
}
