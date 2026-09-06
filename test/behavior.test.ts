import assert from "node:assert/strict";
import test from "node:test";

import { MAX_INPUT_FILE_SIZE, createLatestUploadRunner, validateImageFile } from "../lib/upload.ts";
import { canvasToPngBlob, outputDimensions, prepareImageBitmap } from "../lib/painterly.ts";

test("image validation accepts supported files within the size limit", () => {
  const file = { type: "image/webp", size: MAX_INPUT_FILE_SIZE };

  assert.equal(validateImageFile(file), null);
});

test("image validation explains unsupported and oversized files", () => {
  assert.equal(
    validateImageFile({ type: "image/gif", size: 1 }),
    "Choose a PNG, JPEG, or WebP image.",
  );
  assert.equal(
    validateImageFile({
      type: "image/png",
      size: MAX_INPUT_FILE_SIZE + 1,
    }),
    "Choose an image smaller than 25 MB.",
  );
});

test("the latest upload supersedes an older unfinished upload", async () => {
  const runLatestUpload = createLatestUploadRunner();
  let finishFirstUpload: (() => void) | undefined;
  const appliedFiles: string[] = [];

  const firstUpload = runLatestUpload(async (isCurrent) => {
    await new Promise<void>((resolve) => {
      finishFirstUpload = () => resolve();
    });
    if (isCurrent()) appliedFiles.push("first.webp");
  });

  await runLatestUpload(async (isCurrent) => {
    if (isCurrent()) appliedFiles.push("second.webp");
  });
  finishFirstUpload?.();
  await firstUpload;

  assert.deepEqual(appliedFiles, ["second.webp"]);
});

test("cancelling uploads invalidates unfinished work", async () => {
  const runLatestUpload = createLatestUploadRunner();
  let finishUpload: (() => void) | undefined;
  let applied = false;

  const upload = runLatestUpload(async (isCurrent) => {
    await new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    applied = isCurrent();
  });

  runLatestUpload.cancel();
  finishUpload?.();
  await upload;

  assert.equal(applied, false);
});

test("output dimensions preserve aspect ratio and cap the longest edge", () => {
  assert.deepEqual(outputDimensions(4000, 2000), {
    width: 1600,
    height: 800,
  });
  assert.deepEqual(outputDimensions(1086, 1448), {
    width: 1086,
    height: 1448,
  });
});

test("large images are resized before WebGL upload", async () => {
  let sourceClosed = false;
  const sourceBitmap = {
    width: 4000,
    height: 2000,
    close() {
      sourceClosed = true;
    },
  };
  const resizedBitmap = {
    width: 1600,
    height: 800,
    close() {},
  };
  const calls: unknown[][] = [];
  const createBitmap = async (...args: unknown[]) => {
    calls.push(args);
    return calls.length === 1 ? sourceBitmap : resizedBitmap;
  };

  const prepared = await prepareImageBitmap(
    new Blob([], { type: "image/jpeg" }),
    createBitmap as typeof createImageBitmap,
  );

  assert.equal(prepared.bitmap, resizedBitmap);
  assert.deepEqual(prepared.dimensions, { width: 1600, height: 800 });
  assert.equal(sourceClosed, true);
  assert.deepEqual(calls[1].slice(1, 5), [0, 0, 4000, 2000]);
  assert.deepEqual(calls[1][5], {
    resizeWidth: 1600,
    resizeHeight: 800,
    resizeQuality: "high",
  });
});

test("a failed resize releases the decoded source bitmap", async () => {
  let sourceClosed = false;
  let callCount = 0;
  const createBitmap = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        width: 4000,
        height: 2000,
        close() {
          sourceClosed = true;
        },
      };
    }
    throw new Error("resize failed");
  };

  await assert.rejects(
    prepareImageBitmap(
      new Blob([], { type: "image/jpeg" }),
      createBitmap as typeof createImageBitmap,
    ),
    /resize failed/,
  );
  assert.equal(sourceClosed, true);
});

test("PNG conversion rejects when the browser returns no blob", async () => {
  const canvas = {
    toBlob(callback: BlobCallback) {
      callback(null);
    },
  };

  await assert.rejects(
    canvasToPngBlob(canvas as HTMLCanvasElement),
    /The browser could not create a PNG/,
  );
});

test("PNG conversion resolves the generated blob", async () => {
  const blob = new Blob([], { type: "image/png" });
  const canvas = {
    toBlob(callback: BlobCallback, type?: string) {
      assert.equal(type, "image/png");
      callback(blob);
    },
  };

  assert.equal(await canvasToPngBlob(canvas as HTMLCanvasElement), blob);
});
