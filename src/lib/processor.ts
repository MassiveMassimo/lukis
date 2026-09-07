import type { ImageDimensions } from "./image";

export const GRAPHICS_REQUIRED =
  "Lukis needs WebGPU or WebGL 2. Open it in a browser with graphics acceleration enabled on a supported device.";

export interface ImageProcessor {
  load(
    file: Blob,
    isCurrent: () => boolean,
    strength: number,
    brush: number,
    thickness?: number,
  ): Promise<ImageDimensions | null>;
  render(strength: number, brush: number, thickness?: number): Promise<void>;
  snapshot(canvas: HTMLCanvasElement): Promise<void>;
  exportPng(): Promise<Blob>;
  download(filename: string): Promise<void>;
  clear(): void;
  dispose(): void;
  readonly filterPasses: number;
}

export async function createImageProcessor(
  canvas: HTMLCanvasElement,
  onFatal: (error: Error) => void = () => {},
): Promise<ImageProcessor> {
  if (navigator.gpu) {
    try {
      const { createWebGpuProcessor } = await import("./processor-webgpu");
      return await createWebGpuProcessor(canvas, onFatal);
    } catch {
      // Startup has not bound the visible canvas. Try the local WebGL2 renderer.
    }
  }
  try {
    const { createWebGlProcessor } = await import("./processor-webgl");
    return createWebGlProcessor(canvas, onFatal);
  } catch {
    throw new Error(GRAPHICS_REQUIRED);
  }
}
