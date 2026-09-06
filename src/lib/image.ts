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
  if (dimensions.width === sourceBitmap.width && dimensions.height === sourceBitmap.height)
    return { bitmap: sourceBitmap, dimensions };
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
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The browser could not create a PNG."))),
      "image/png",
    );
  });
}
