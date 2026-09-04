export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_INPUT_FILE_SIZE = 25 * 1024 * 1024;

export interface ImageFileLike {
  type: string;
  size: number;
}

export function validateImageFile(file: ImageFileLike | null | undefined) {
  if (!file || !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return "Choose a PNG, JPEG, or WebP image.";
  }

  if (file.size > MAX_INPUT_FILE_SIZE) {
    return "Choose an image smaller than 25 MB.";
  }

  return null;
}

export type UploadIsCurrent = () => boolean;
export type LatestUploadTask<TResult> = (
  isCurrent: UploadIsCurrent,
) => TResult | PromiseLike<TResult>;
export type LatestUploadRunner = <TResult>(upload: LatestUploadTask<TResult>) => Promise<TResult>;

export function createLatestUploadRunner(): LatestUploadRunner {
  let latestRequest = 0;

  return async function runLatestUpload<TResult>(
    upload: LatestUploadTask<TResult>,
  ): Promise<TResult> {
    const request = ++latestRequest;
    return upload(() => request === latestRequest);
  };
}
