import type { ImageDimensions } from "./image";
import type { RippleMotion } from "./ripple-motion";
export type { RippleMotion } from "./ripple-motion";

export const GRAPHICS_REQUIRED =
  "Lukis needs WebGPU or WebGL 2. Open it in a browser with graphics acceleration enabled on a supported device.";

export const DEFAULT_RIPPLE = {
  height: 0.635,
  width: 0.33,
  broadening: 0.036,
  refraction: 0.5,
  dispersion: 0.42,
  colorBoost: 5.4,
  sheen: 0.6,
  shading: 0.38,
  feather: 0.25,
  strength: 2,
  count: 1,
  spacing: 0.3,
  echo: 0.7,
  blurPx: 14,
};
export type RippleSettings = typeof DEFAULT_RIPPLE;

export interface ImageProcessor {
  load(
    file: Blob,
    isCurrent: () => boolean,
    strength: number,
    brush: number,
  ): Promise<ImageDimensions | null>;
  render(strength: number, brush: number): Promise<void>;
  /** Display-only mask and wave. Explicit motion uses short-side travel distance. */
  present(
    progress: number,
    wave?: number,
    settings?: RippleSettings,
    motion?: RippleMotion,
  ): Promise<void>;
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
