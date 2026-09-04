import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

const host = "127.0.0.1";
const root = fileURLToPath(new URL("../", import.meta.url));
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

let baseUrl = "";
let browser: Browser | undefined;
let isolatedRoot: string | undefined;
let server: ChildProcess | undefined;
let serverLog = "";

interface BrowserIssues {
  consoleErrors: string[];
  pageErrors: string[];
}

interface ImageExpectation {
  height: number;
  width: number;
}

interface MarkerSample {
  markerHeight: number;
  markerRatio: number;
  markerWidth: number;
  overlap: boolean;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, host, () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("The test server could not reserve a local port."));
        return;
      }

      socket.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function createIsolatedRoot(): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), "lukis-browser-"));
  const entries = [
    "app",
    "components",
    "lib",
    "public",
    "next-env.d.ts",
    "package.json",
    "postcss.config.mjs",
    "tsconfig.json",
  ];

  await Promise.all(
    entries.map((entry) =>
      cp(join(root, entry), join(destination, entry), {
        recursive: true,
      }),
    ),
  );
  await symlink(join(root, "node_modules"), join(destination, "node_modules"), "dir");
  return destination;
}

function recordServerOutput(chunk: Buffer | string): void {
  serverLog = `${serverLog}${chunk.toString()}`.slice(-8_000);
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Next.js exited before it was ready with code ${child.exitCode}.\n${serverLog}`,
      );
    }

    try {
      // Probes are sequential so they cannot pile up while Next.js compiles.
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }

    // oxlint-disable-next-line no-await-in-loop
    await delay(200);
  }

  throw new Error(`Next.js did not become ready.\n${serverLog}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return Promise.race([once(child, "exit").then(() => true), delay(timeoutMs).then(() => false)]);
}

async function stopServer(): Promise<void> {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;

  child.kill("SIGKILL");
  await waitForExit(child, 5_000);
}

function watchForBrowserErrors(page: Page): BrowserIssues {
  const issues: BrowserIssues = {
    consoleErrors: [],
    pageErrors: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error") issues.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    issues.pageErrors.push(error.message);
  });

  return issues;
}

function assertNoBrowserErrors(issues: BrowserIssues): void {
  assert.deepEqual(issues.consoleErrors, []);
  assert.deepEqual(issues.pageErrors, []);
}

async function createSplitColorPng(page: Page, width: number, height: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ fixtureHeight, fixtureWidth }) => {
      const fixture = document.createElement("canvas");
      fixture.width = fixtureWidth;
      fixture.height = fixtureHeight;
      const context = fixture.getContext("2d");
      if (!context) throw new Error("The image fixture could not be created.");

      context.fillStyle = "#e02418";
      context.fillRect(0, 0, fixtureWidth, fixtureHeight / 2);
      context.fillStyle = "#1824e0";
      context.fillRect(0, fixtureHeight / 2, fixtureWidth, fixtureHeight / 2);
      return fixture.toDataURL("image/png");
    },
    { fixtureHeight: height, fixtureWidth: width },
  );

  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function createCirclePng(page: Page, width: number, height: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ fixtureHeight, fixtureWidth }) => {
      const fixture = document.createElement("canvas");
      fixture.width = fixtureWidth;
      fixture.height = fixtureHeight;
      const context = fixture.getContext("2d");
      if (!context) throw new Error("The marker fixture could not be created.");

      context.fillStyle = "#080808";
      context.fillRect(0, 0, fixtureWidth, fixtureHeight);
      context.fillStyle = "#ff2018";
      context.beginPath();
      context.arc(
        fixtureWidth / 2,
        fixtureHeight / 2,
        Math.min(fixtureWidth, fixtureHeight) * 0.12,
        0,
        Math.PI * 2,
      );
      context.fill();
      return fixture.toDataURL("image/png");
    },
    { fixtureHeight: height, fixtureWidth: width },
  );

  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function captureBoundsRevealFrames(
  page: Page,
  expected: ImageExpectation,
  upload: () => Promise<void>,
): Promise<MarkerSample[]> {
  await page.evaluate(() => {
    const beacon = document.createElement("span");
    beacon.dataset.animationOverlap = "false";
    Object.assign(beacon.style, {
      background: "#000000",
      height: "12px",
      left: "0",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      width: "12px",
      zIndex: "2147483647",
    });
    document.body.append(beacon);

    function updateBeacon() {
      const frame = document.querySelector(".canvas-frame");
      const surface = document.querySelector(".canvas-surface");
      if (frame instanceof HTMLElement && surface instanceof HTMLElement) {
        const opacity = Number.parseFloat(getComputedStyle(surface).opacity);
        const isOverlap =
          frame.dataset.hasFile === "true" &&
          getComputedStyle(frame).transform !== "none" &&
          opacity > 0.1 &&
          opacity < 0.999;
        beacon.dataset.animationOverlap = String(isOverlap);
        beacon.style.background = isOverlap ? "#00ff00" : "#000000";
      }
      requestAnimationFrame(updateBeacon);
    }
    requestAnimationFrame(updateBeacon);
  });

  const client = await page.context().newCDPSession(page);
  const frames: string[] = [];
  client.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
    frames.push(event.data);
    void client.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await client.send("Page.startScreencast", {
    everyNthFrame: 1,
    format: "png",
    maxHeight: 480,
    maxWidth: 640,
  });

  await upload();
  await page.waitForFunction(
    ({ height, width }) => {
      const canvas = document.querySelector("canvas");
      const frame = document.querySelector(".canvas-frame");
      const surface = document.querySelector(".canvas-surface");
      return (
        canvas instanceof HTMLCanvasElement &&
        frame instanceof HTMLElement &&
        surface instanceof HTMLElement &&
        canvas.width === width &&
        canvas.height === height &&
        frame.dataset.hasFile === "true" &&
        getComputedStyle(frame).transform === "none" &&
        Number.parseFloat(getComputedStyle(surface).opacity) >= 0.999
      );
    },
    expected,
    { timeout: 30_000 },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await client.send("Page.stopScreencast");

  return page.evaluate(async (encodedFrames) => {
    const samples: MarkerSample[] = [];

    for (const encodedFrame of encodedFrames) {
      // Frames must be decoded in sequence to keep peak browser memory bounded.
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(`data:image/png;base64,${encodedFrame}`);
      // oxlint-disable-next-line no-await-in-loop
      const bitmap = await createImageBitmap(await response.blob());
      const sample = document.createElement("canvas");
      sample.width = bitmap.width;
      sample.height = bitmap.height;
      const context = sample.getContext("2d");
      if (!context) throw new Error("The rendered marker could not be sampled.");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();

      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let beaconPixels = 0;
      let count = 0;
      let maximumX = 0;
      let maximumY = 0;
      let minimumX = sample.width;
      let minimumY = sample.height;

      for (let y = 0; y < sample.height; y += 2) {
        for (let x = 0; x < sample.width; x += 2) {
          const offset = (y * sample.width + x) * 4;
          const red = pixels[offset] ?? 0;
          const green = pixels[offset + 1] ?? 0;
          const blue = pixels[offset + 2] ?? 0;
          if (x < 12 && y < 12 && green > 120 && green - Math.max(red, blue) > 80) {
            beaconPixels += 1;
          }
          if (red <= 32 || red - Math.max(green, blue) <= 16) continue;

          count += 1;
          minimumX = Math.min(minimumX, x);
          maximumX = Math.max(maximumX, x);
          minimumY = Math.min(minimumY, y);
          maximumY = Math.max(maximumY, y);
        }
      }

      if (count < 25) continue;
      const markerHeight = maximumY - minimumY + 2;
      const markerWidth = maximumX - minimumX + 2;
      samples.push({
        markerHeight,
        markerRatio: markerWidth / markerHeight,
        markerWidth,
        overlap: beaconPixels >= 2,
      });
    }

    return samples;
  }, frames);
}

function getBrowser(): Browser {
  if (!browser) throw new Error("The browser did not start.");
  return browser;
}

async function waitForProcessedImage(page: Page, expected: ImageExpectation): Promise<void> {
  await page.waitForFunction(
    ({ height, width }) => {
      const canvas = document.querySelector("canvas");
      const clip = document.querySelector(".canvas-clip");
      const surface = document.querySelector(".canvas-surface");
      if (!(canvas instanceof HTMLCanvasElement) || !(surface instanceof HTMLElement)) {
        return false;
      }

      return (
        canvas.height === height &&
        canvas.width === width &&
        clip?.getAttribute("aria-hidden") === "false" &&
        Number.parseFloat(getComputedStyle(surface).opacity) >= 0.999
      );
    },
    expected,
    { timeout: 30_000 },
  );
}

async function assertImageGeometry(page: Page, expected: ImageExpectation): Promise<void> {
  const geometry = await page.evaluate(() => {
    const frame = document.querySelector(".canvas-frame");
    const canvas = document.querySelector("canvas");
    const surface = document.querySelector(".canvas-surface");

    if (
      !(frame instanceof HTMLElement) ||
      !(canvas instanceof HTMLCanvasElement) ||
      !(surface instanceof HTMLElement)
    ) {
      throw new Error("The processed image geometry is incomplete.");
    }

    const frameRect = frame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const surfaceStyle = getComputedStyle(surface);

    return {
      canvasHeight: canvas.height,
      canvasRatio: canvasRect.width / canvasRect.height,
      canvasWidth: canvas.width,
      edgeFade: surfaceStyle.getPropertyValue("--edge-fade").trim(),
      frameRatio: frameRect.width / frameRect.height,
      clipPath: surfaceStyle.clipPath,
      maskImage: surfaceStyle.maskImage,
      objectFit: getComputedStyle(canvas).objectFit,
      revealX: surfaceStyle.getPropertyValue("--reveal-x").trim(),
      revealY: surfaceStyle.getPropertyValue("--reveal-y").trim(),
    };
  });
  const expectedRatio = expected.width / expected.height;

  assert.equal(geometry.canvasWidth, expected.width);
  assert.equal(geometry.canvasHeight, expected.height);
  assert.ok(Math.abs(geometry.frameRatio - expectedRatio) < 0.01);
  assert.ok(Math.abs(geometry.canvasRatio - expectedRatio) < 0.01);
  assert.equal(geometry.objectFit, "cover");
  assert.ok(geometry.clipPath === "none" || geometry.clipPath === "");
  assert.notEqual(geometry.maskImage, "none");
  assert.equal(geometry.revealX, "0%");
  assert.equal(geometry.revealY, "0%");
  assert.equal(geometry.edgeFade, "0%");
}

async function assertGuidesMatchFrame(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const frame = document.querySelector(".canvas-frame");
        const top = document.querySelector(".guide-line-top");
        const right = document.querySelector(".guide-line-right");
        const bottom = document.querySelector(".guide-line-bottom");
        const left = document.querySelector(".guide-line-left");
        if (
          !(frame instanceof HTMLElement) ||
          !(top instanceof HTMLElement) ||
          !(right instanceof HTMLElement) ||
          !(bottom instanceof HTMLElement) ||
          !(left instanceof HTMLElement)
        ) {
          return false;
        }

        const frameRect = frame.getBoundingClientRect();
        return (
          Math.abs(top.getBoundingClientRect().top - frameRect.top) <= 2 &&
          Math.abs(right.getBoundingClientRect().left - frameRect.right) <= 2 &&
          Math.abs(bottom.getBoundingClientRect().top - frameRect.bottom) <= 2 &&
          Math.abs(left.getBoundingClientRect().left - frameRect.left) <= 2
        );
      },
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);

  const geometry = await page.evaluate(() => {
    const frame = document.querySelector(".canvas-frame");
    const top = document.querySelector(".guide-line-top");
    const right = document.querySelector(".guide-line-right");
    const bottom = document.querySelector(".guide-line-bottom");
    const left = document.querySelector(".guide-line-left");

    if (
      !(frame instanceof HTMLElement) ||
      !(top instanceof HTMLElement) ||
      !(right instanceof HTMLElement) ||
      !(bottom instanceof HTMLElement) ||
      !(left instanceof HTMLElement)
    ) {
      throw new Error("The frame guides are incomplete.");
    }

    const frameRect = frame.getBoundingClientRect();
    const guides = top.parentElement;
    const stage = frame.parentElement;
    return {
      frameBottom: frameRect.bottom,
      frameLeft: frameRect.left,
      frameRight: frameRect.right,
      frameTop: frameRect.top,
      frameTransform: getComputedStyle(frame).transform,
      guideContainerTop: guides?.getBoundingClientRect().top ?? null,
      guideTopProperty: getComputedStyle(top).top,
      guideTopTransform: getComputedStyle(top).transform,
      guideBottom: bottom.getBoundingClientRect().top,
      guideLeft: left.getBoundingClientRect().left,
      guideRight: right.getBoundingClientRect().left,
      guideTop: top.getBoundingClientRect().top,
      stageTop: stage?.getBoundingClientRect().top ?? null,
    };
  });

  assert.ok(
    Math.abs(geometry.guideTop - geometry.frameTop) <= 2,
    `top guide should match frame: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    Math.abs(geometry.guideRight - geometry.frameRight) <= 2,
    `right guide ${geometry.guideRight} should match frame ${geometry.frameRight}`,
  );
  assert.ok(
    Math.abs(geometry.guideBottom - geometry.frameBottom) <= 2,
    `bottom guide ${geometry.guideBottom} should match frame ${geometry.frameBottom}`,
  );
  assert.ok(
    Math.abs(geometry.guideLeft - geometry.frameLeft) <= 2,
    `left guide ${geometry.guideLeft} should match frame ${geometry.frameLeft}`,
  );
}

async function assertPortraitIsUpright(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error("The processed image canvas is missing.");
    }

    const sample = document.createElement("canvas");
    sample.width = canvas.width;
    sample.height = canvas.height;
    const context = sample.getContext("2d");
    if (!context) throw new Error("The orientation sample could not be created.");
    context.drawImage(canvas, 0, 0);

    return {
      top: Array.from(
        context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 4), 1, 1)
          .data,
      ),
      bottom: Array.from(
        context.getImageData(
          Math.floor(canvas.width / 2),
          Math.floor((canvas.height * 3) / 4),
          1,
          1,
        ).data,
      ),
    };
  });

  assert.ok(colors.top[0] > colors.top[2], `expected red at top, received ${colors.top}`);
  assert.ok(
    colors.bottom[2] > colors.bottom[0],
    `expected blue at bottom, received ${colors.bottom}`,
  );
}

async function assertUploadStateRestored(page: Page): Promise<void> {
  const dropzone = page.getByRole("button", {
    name: "Drop or browse an image to make it painterly",
  });
  try {
    await dropzone.waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      controls: document.querySelectorAll(".controls").length,
      dropzones: document.querySelectorAll(".dropzone").length,
      frameHasFile: document.querySelector(".canvas-frame")?.getAttribute("data-has-file"),
      previewHidden: document.querySelector(".canvas-clip")?.getAttribute("aria-hidden"),
      restartDisabled:
        document.querySelector<HTMLButtonElement>('[aria-label="Restart with another image"]')
          ?.disabled ?? null,
      status: document.querySelector(".status")?.textContent,
    }));
    throw new Error(`Upload state was not restored: ${JSON.stringify(state)}`, {
      cause: error,
    });
  }
  await page.waitForFunction(() => {
    const element = document.querySelector(".dropzone");
    return (
      element instanceof HTMLElement &&
      Number.parseFloat(getComputedStyle(element).opacity) >= 0.999
    );
  });

  assert.equal(await dropzone.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Restart with another image" }).count(), 0);
  assert.equal(await page.locator(".controls").count(), 0);
  assert.equal(await page.locator(".canvas-frame").getAttribute("data-has-file"), null);
  assert.equal(await page.locator('input[type="file"]').isEnabled(), true);
}

before(async () => {
  isolatedRoot = await createIsolatedRoot();
  const port = await reservePort();
  baseUrl = `http://${host}:${port}`;
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "--webpack", "--hostname", host, "--port", String(port)],
    {
      cwd: isolatedRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = child;
  child.stdout?.on("data", recordServerOutput);
  child.stderr?.on("data", recordServerOutput);

  await waitForServer(baseUrl, child);
  browser = await chromium.launch({
    args: ["--use-angle=swiftshader"],
    headless: true,
  });
});

after(async () => {
  await browser?.close();
  await stopServer();
  if (isolatedRoot) {
    await rm(isolatedRoot, { force: true, recursive: true });
    isolatedRoot = undefined;
  }
});

test("keeps a 1448 by 1086 landscape image undistorted", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 1280, height: 960 },
  });
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "landscape.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 1448, 1086),
    });
    await waitForProcessedImage(page, { height: 1086, width: 1448 });
    await assertImageGeometry(page, { height: 1086, width: 1448 });
    await assertGuidesMatchFrame(page);
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("keeps rendered pixels undistorted during the bounds and reveal overlap", async () => {
  const context = await getBrowser().newContext({
    reducedMotion: "no-preference",
    viewport: { width: 1280, height: 960 },
  });
  await context.addInitScript(() => {
    const boundsTransition = {
      type: "easing",
      duration: 4,
      ease: [1, -0.4, 0.35, 0.95],
    };
    const revealTransition = {
      type: "easing",
      duration: 4,
      ease: [0.22, 1, 0.36, 1],
    };
    const values = {
      "bounds.transition": boundsTransition,
      "reveal.transition": revealTransition,
    };
    localStorage.setItem(
      "dialkit:painterly",
      JSON.stringify({
        version: 1,
        values,
        baseValues: values,
        activePresetId: null,
      }),
    );
  });
  const page = await context.newPage();
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    const fixture = await createCirclePng(page, 360, 480);
    const samples = await captureBoundsRevealFrames(page, { height: 480, width: 360 }, () =>
      page.locator('input[type="file"]').setInputFiles({
        name: "circle-marker.png",
        mimeType: "image/png",
        buffer: fixture,
      }),
    );
    const overlapSamples = samples.filter(({ overlap }) => overlap);
    const finalSample = samples.at(-1);

    assert.ok(finalSample, "expected a final rendered marker sample");
    assert.ok(
      overlapSamples.length >= 1,
      `expected a visible overlap sample, received ${JSON.stringify(samples)}`,
    );
    assert.ok(
      overlapSamples.every(
        ({ markerRatio }) => Math.abs(markerRatio / finalSample.markerRatio - 1) < 0.025,
      ),
      `the rendered circle distorted during overlap: ${JSON.stringify(overlapSamples)}`,
    );
    assert.equal(finalSample.overlap, false);
    assert.ok(
      finalSample.markerRatio > 0.9 && finalSample.markerRatio < 1.1,
      `the final rendered circle ratio was ${finalSample.markerRatio}`,
    );
    assertNoBrowserErrors(issues);
  } finally {
    await context.close();
  }
});

test("tunes, downloads, and restarts a processed image", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 960 },
  });
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "controls.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 64, 48),
    });
    await waitForProcessedImage(page, { height: 48, width: 64 });

    const paint = page.getByRole("slider", { name: "Paint" });
    const brush = page.getByRole("slider", { name: "Brush" });
    assert.equal(await paint.getAttribute("aria-valuenow"), "78");
    assert.equal(await brush.getAttribute("aria-valuenow"), "1.4");
    await paint.press("ArrowRight");
    await brush.press("End");
    assert.equal(await paint.getAttribute("aria-valuenow"), "79");
    assert.equal(await brush.getAttribute("aria-valuenow"), "3");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download painterly PNG" }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "controls-painterly.png");
    await page.waitForFunction(
      () => document.querySelector(".status")?.textContent === "Painterly PNG download started.",
    );

    const restart = page.getByRole("button", {
      name: "Restart with another image",
    });
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>('[aria-label="Restart with another image"]')
          ?.disabled,
    );
    await restart.click();
    await assertUploadStateRestored(page);
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("keeps a 1086 by 1448 portrait image upright and undistorted", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 1280, height: 960 },
  });
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 1086, 1448),
    });
    await waitForProcessedImage(page, { height: 1448, width: 1086 });
    await assertImageGeometry(page, { height: 1448, width: 1086 });
    await assertPortraitIsUpright(page);
    await assertGuidesMatchFrame(page);
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("reports invalid files and keeps upload recovery available", async () => {
  const page = await getBrowser().newPage();
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.locator('input[type="file"]').setInputFiles({
      name: "animation.gif",
      mimeType: "image/gif",
      buffer: Buffer.from("GIF89a"),
    });

    const error = page.locator(".status.error");
    await error.waitFor({ state: "visible" });
    assert.equal(await error.innerText(), "Choose a PNG, JPEG, or WebP image.");
    await assertUploadStateRestored(page);
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("disables upload when WebGL 2 is unavailable", async () => {
  const context = await getBrowser().newContext();
  await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    const patchedGetContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...options: unknown[]
    ) {
      if (type === "webgl2") return null;
      return Reflect.apply(getContext, this, [type, ...options]);
    };
    HTMLCanvasElement.prototype.getContext =
      patchedGetContext as typeof HTMLCanvasElement.prototype.getContext;
  });
  const page = await context.newPage();
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    const dropzone = page.getByRole("button", {
      name: "Drop or browse an image to make it painterly",
    });
    await dropzone.waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Drop or browse an image to make it painterly"]',
        )?.disabled === true,
    );

    assert.equal(await dropzone.isEnabled(), false);
    assert.equal(
      await page.locator(".status.error").innerText(),
      "This tool needs a browser with WebGL 2 support.",
    );
    assertNoBrowserErrors(issues);
  } finally {
    await context.close();
  }
});
