import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

const host = "127.0.0.1";
const root = fileURLToPath(new URL("../", import.meta.url));

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

interface RevealCenterSample {
  frameMask: string;
  imageMask: string;
  revealTransform: string;
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
  const entries = ["src", "public", "astro.config.mjs", "package.json", "tsconfig.json"];

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
        `Astro exited before it was ready with code ${child.exitCode}.\n${serverLog}`,
      );
    }

    try {
      // Probes are sequential so they cannot pile up while Astro compiles.
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

  throw new Error(`Astro did not become ready.\n${serverLog}`);
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
        // Keep the marker inside the crop while the image covers wide, shallow bounds.
        Math.min(fixtureWidth, fixtureHeight) * 0.1,
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

    let revealStarted: number | undefined;
    function updateBeacon() {
      const frame = document.querySelector(".canvas-frame");
      const reveal = document.querySelector(".canvas-clip");
      if (frame instanceof HTMLElement && reveal instanceof HTMLElement) {
        const progress = Number(reveal.dataset.revealProgress ?? 0);
        if (progress > 0 && revealStarted === undefined) revealStarted = performance.now();
        // The mask can clip the marker while its lit edge crosses it. Measure
        // the revealed interior late in this eased reveal, while bounds still move.
        // GPU verification separately checks the mask's circular edge and growth.
        const isOverlap =
          revealStarted !== undefined &&
          performance.now() - revealStarted >= 1500 &&
          frame.dataset.hasFile === "true" &&
          frame.dataset.animating === "true" &&
          progress > 0.1 &&
          progress < 0.999;
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
      const reveal = document.querySelector(".canvas-clip");
      return (
        canvas instanceof HTMLCanvasElement &&
        frame instanceof HTMLElement &&
        reveal instanceof HTMLElement &&
        canvas.width === width &&
        canvas.height === height &&
        frame.dataset.hasFile === "true" &&
        frame.dataset.animating !== "true" &&
        Number.parseFloat(getComputedStyle(reveal).opacity) >= 0.999
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
  const finalFrame = await client.send("Page.captureScreenshot", {
    clip: { height: 960, scale: 0.5, width: 1280, x: 0, y: 0 },
    format: "png",
  });
  frames.push(finalFrame.data);
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
      let sumX = 0;
      let sumXSquare = 0;
      let sumY = 0;
      let sumYSquare = 0;

      for (let y = 0; y < sample.height; y += 1) {
        for (let x = 0; x < sample.width; x += 1) {
          const offset = (y * sample.width + x) * 4;
          const red = pixels[offset] ?? 0;
          const green = pixels[offset + 1] ?? 0;
          const blue = pixels[offset + 2] ?? 0;
          if (x < 12 && y < 12 && green > 120 && green - Math.max(red, blue) > 80) {
            beaconPixels += 1;
          }
          if (red <= 32 || red - Math.max(green, blue) <= 16) continue;

          count += 1;
          sumX += x;
          sumXSquare += x * x;
          sumY += y;
          sumYSquare += y * y;
        }
      }

      if (count < 25) continue;
      const markerWidth = Math.sqrt(sumXSquare / count - (sumX / count) ** 2);
      const markerHeight = Math.sqrt(sumYSquare / count - (sumY / count) ** 2);
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

async function captureRevealCenterSamples(
  page: Page,
  expected: ImageExpectation,
  upload: () => Promise<void>,
): Promise<RevealCenterSample[]> {
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      revealCenterSamples: RevealCenterSample[];
    };
    browserWindow.revealCenterSamples = [];

    function sampleRevealCenter() {
      const frame = document.querySelector(".canvas-frame");
      const clip = document.querySelector(".canvas-clip");
      const surface = document.querySelector(".canvas-surface");

      if (
        frame instanceof HTMLElement &&
        clip instanceof HTMLElement &&
        surface instanceof HTMLElement &&
        frame.dataset.hasFile === "true"
      ) {
        const clipStyle = getComputedStyle(clip);
        const progress = Number(clip.dataset.revealProgress ?? 0);
        if (progress > 0.01 && progress < 0.999) {
          browserWindow.revealCenterSamples.push({
            frameMask: getComputedStyle(frame).maskImage,
            imageMask: getComputedStyle(surface).maskImage,
            revealTransform: clipStyle.transform,
          });
        }
      }

      requestAnimationFrame(sampleRevealCenter);
    }

    requestAnimationFrame(sampleRevealCenter);
  });

  await upload();
  await waitForProcessedImage(page, expected);

  return page.evaluate(
    () =>
      (
        window as typeof window & {
          revealCenterSamples?: RevealCenterSample[];
        }
      ).revealCenterSamples ?? [],
  );
}

function getBrowser() {
  if (!browser) throw new Error("The browser did not start.");
  const runningBrowser = browser;
  async function newContext(options?: Parameters<Browser["newContext"]>[0]) {
    const context = await runningBrowser.newContext(options);
    if (process.env.LUKIS_TEST_RENDERER === "webgl2") {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      });
    }
    return context;
  }
  return {
    newContext,
    async newPage(options?: Parameters<Browser["newPage"]>[0]) {
      return (await newContext(options)).newPage();
    },
  };
}

async function waitForProcessedImage(page: Page, expected: ImageExpectation): Promise<void> {
  await page.waitForFunction(
    ({ height, width }) => {
      const canvas = document.querySelector("canvas");
      const clip = document.querySelector(".canvas-clip");
      const dropzone = document.querySelector<HTMLButtonElement>(".dropzone");
      const reveal = clip;
      if (!(canvas instanceof HTMLCanvasElement) || !(reveal instanceof HTMLElement)) {
        return false;
      }

      return (
        canvas.height === height &&
        canvas.width === width &&
        clip?.getAttribute("aria-hidden") === "false" &&
        (document.querySelector(".canvas-frame") as HTMLElement).dataset.animating !== "true" &&
        dropzone?.disabled === false &&
        Number.parseFloat(getComputedStyle(reveal).opacity) >= 0.999
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
    const reveal = document.querySelector(".canvas-clip");

    if (
      !(frame instanceof HTMLElement) ||
      !(canvas instanceof HTMLCanvasElement) ||
      !(reveal instanceof HTMLElement)
    ) {
      throw new Error("The processed image geometry is incomplete.");
    }

    const frameRect = frame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const revealStyle = getComputedStyle(reveal);

    return {
      canvasHeight: canvas.height,
      canvasRatio: canvasRect.width / canvasRect.height,
      canvasWidth: canvas.width,
      frameRatio: frameRect.width / frameRect.height,
      clipPath: revealStyle.clipPath,
      maskImage: getComputedStyle(frame).maskImage,
      outerMask: revealStyle.maskImage,
      outerFilter: revealStyle.filter,
      imageFilter: getComputedStyle(canvas.parentElement!).filter,
      objectFit: getComputedStyle(canvas).objectFit,
    };
  });
  const expectedRatio = expected.width / expected.height;

  assert.equal(geometry.canvasWidth, expected.width);
  assert.equal(geometry.canvasHeight, expected.height);
  assert.ok(Math.abs(geometry.frameRatio - expectedRatio) < 0.01);
  assert.ok(Math.abs(geometry.canvasRatio - expectedRatio) < 0.01);
  assert.equal(geometry.objectFit, "cover");
  assert.ok(geometry.clipPath === "none" || geometry.clipPath === "");
  assert.equal(geometry.outerMask, "none");
  assert.equal(geometry.outerFilter, "none");
  assert.equal(geometry.imageFilter, "blur(0px)");
  assert.equal(geometry.maskImage, "none");
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

async function downloadPixels(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download painterly PNG" }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#download")?.disabled,
  );
  return `data:image/png;base64,${Buffer.concat(chunks).toString("base64")}`;
}

async function assertPortraitIsUpright(page: Page): Promise<void> {
  // WebGPU presentation textures expire after compositing; inspect the persistent PNG output.
  const png = await downloadPixels(page);
  const colors = await page.evaluate(async (source) => {
    const canvas = new Image();
    canvas.src = source;
    await canvas.decode();

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
  }, png);

  assert.ok(colors.top[0] > colors.top[2], `expected red at top, received ${colors.top}`);
  assert.ok(
    colors.bottom[2] > colors.bottom[0],
    `expected blue at bottom, received ${colors.bottom}`,
  );
}

async function assertUploadStateRestored(page: Page): Promise<void> {
  const dropzone = page.getByRole("button", {
    name: "Turn an image into a painting",
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
  assert.equal(await page.locator(".controls").isVisible(), false);
  assert.equal(await page.locator(".canvas-frame").getAttribute("data-has-file"), null);
  assert.equal(await page.locator('input[type="file"]').isEnabled(), true);
}

before(async () => {
  isolatedRoot = await createIsolatedRoot();
  const port = await reservePort();
  baseUrl = `http://${host}:${port}`;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { dev } from "astro"; const server = await dev({ root: process.cwd(), server: { host: "${host}", port: ${port} } }); process.on("SIGTERM", async () => { await server.stop(); process.exit(0); });`,
    ],
    {
      cwd: isolatedRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server = child;
  child.stdout?.on("data", recordServerOutput);
  child.stderr?.on("data", recordServerOutput);

  await waitForServer(baseUrl, child);
});

// Helium exits when an isolated browser context closes, even with a blank tab open.
beforeEach(async () => {
  browser = await chromium.launch({
    executablePath: "/Applications/Helium.app/Contents/MacOS/Helium",
    args: ["--disable-features=HeliumNoiseCanvas"],
    headless: true,
  });
});

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

after(async () => {
  await browser?.close();
  await stopServer();
  if (isolatedRoot) {
    await rm(isolatedRoot, { force: true, recursive: true });
    isolatedRoot = undefined;
  }
});

for (const reduce of [false, true]) {
  test(`image reveal ${reduce ? "skips the ripple with reduced motion" : "runs one finite ripple"}`, async () => {
    const page = await getBrowser().newPage({
      reducedMotion: reduce ? "reduce" : "no-preference",
    });
    const issues = watchForBrowserErrors(page);
    await page.addInitScript(() => {
      let draws = 0;
      Object.defineProperty(window, "revealDraws", { get: () => draws });
      if (typeof GPUQueue !== "undefined") {
        const submit = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function (commands) {
          draws++;
          return submit.call(this, commands);
        };
      }
      const draw = WebGL2RenderingContext.prototype.drawArrays;
      WebGL2RenderingContext.prototype.drawArrays = function (...args) {
        draws++;
        return draw.apply(this, args);
      };
    });
    const readDraws = () =>
      page.evaluate(() => (window as typeof window & { revealDraws: number }).revealDraws);
    try {
      await page.goto(baseUrl);
      await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
      const fixture = await createCirclePng(page, 360, 480);
      // Both first upload and replacement must animate once, then stop drawing.
      for (let upload = 0; upload < 2; upload++) {
        // oxlint-disable-next-line no-await-in-loop
        const initialDraws = await readDraws();
        // oxlint-disable-next-line no-await-in-loop
        await page.locator('input[type="file"]').setInputFiles({
          name: `ripple-${upload}.png`,
          mimeType: "image/png",
          buffer: fixture,
        });
        // oxlint-disable-next-line no-await-in-loop
        await waitForProcessedImage(page, { width: 360, height: 480 });
        // oxlint-disable-next-line no-await-in-loop
        const settled = await readDraws();
        const count = settled - initialDraws;
        assert.ok(reduce ? count <= 4 : count > 8, `Unexpected reveal draw count: ${count}`);
        // oxlint-disable-next-line no-await-in-loop
        await page.waitForTimeout(200);
        // oxlint-disable-next-line no-await-in-loop
        assert.equal(await readDraws(), settled, "Ripple must stop drawing after reveal");
      }
      assertNoBrowserErrors(issues);
    } finally {
      await page.close();
    }
  });
}

test("drop lighting follows the pointer and reveal origins survive resize, replay, and failed replacement", async () => {
  const page = await getBrowser().newPage({ colorScheme: "light", reducedMotion: "no-preference" });
  const issues = watchForBrowserErrors(page);
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    const zone = page.locator(".dropzone");
    const bounds = (await zone.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.3);
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector(".drop-light")!).opacity) > 0.3,
    );
    const light = await page
      .locator(".drop-light")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const dark = await page
      .locator(".drop-light")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    assert.notEqual(light, dark, "System dark mode switches the shadow to a spotlight");
    await page.mouse.move(5, 5);
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector(".drop-light")!).opacity) === 0,
    );
    const buffer = await createCirclePng(page, 360, 480);
    const transfer = await page.evaluateHandle((encoded) => {
      const data = new DataTransfer();
      data.items.add(
        new File([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))], "drop.png", {
          type: "image/png",
        }),
      );
      return data;
    }, buffer.toString("base64"));
    await zone.dispatchEvent("dragenter", {
      dataTransfer: transfer,
      clientX: bounds.x + 80,
      clientY: bounds.y + 60,
    });
    // Retarget after the fade finishes so opacity cannot mask a tracking race.
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector(".drop-light")!).opacity) === 1,
    );
    await zone.dispatchEvent("dragover", {
      dataTransfer: transfer,
      clientX: bounds.x + 160,
      clientY: bounds.y + 90,
    });
    await page.waitForFunction(() => {
      const matrix = new DOMMatrix(
        getComputedStyle(document.querySelector(".drop-light-position")!).transform,
      );
      return matrix.e > 120 && matrix.e < 190 && matrix.f > 60 && matrix.f < 120;
    });
    const expanded = (await zone.boundingBox())!;
    await zone.dispatchEvent("drop", {
      dataTransfer: transfer,
      clientX: expanded.x + expanded.width * 0.12,
      clientY: expanded.y + expanded.height * 0.18,
    });
    await waitForProcessedImage(page, { width: 360, height: 480 });
    const origin = await page.locator(".canvas-clip").getAttribute("data-reveal-origin");
    const [x, y] = origin!.split(",").map(Number);
    assert.ok(
      Math.abs(x - 0.12) < 0.005 && Math.abs(y - 0.18) < 0.005,
      "Drop point remains relative to the resized image",
    );
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector(".drop-light")!).opacity) === 0,
    );
    await page.getByRole("button", { name: "Ripple", exact: true }).click();
    await page.getByRole("button", { name: "Replay reveal", exact: true }).click();
    await waitForProcessedImage(page, { width: 360, height: 480 });
    assert.equal(await page.locator(".canvas-clip").getAttribute("data-reveal-origin"), origin);
    await page.locator("#image-input").setInputFiles({
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from("invalid image"),
    });
    await page.waitForFunction(() =>
      document.querySelector(".status")?.textContent?.includes("could not be processed"),
    );
    assert.equal(await page.locator(".canvas-clip").getAttribute("data-reveal-origin"), origin);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page
      .locator("#image-input")
      .setInputFiles({ name: "picker.png", mimeType: "image/png", buffer });
    await waitForProcessedImage(page, { width: 360, height: 480 });
    assert.equal(
      await page.locator(".canvas-clip").getAttribute("data-reveal-origin"),
      "0.5,0.5",
      "Picker uploads reset the origin to center",
    );
    await transfer.dispose();
    // The deliberately invalid image is reported through the normal error path.
    assert.deepEqual(issues.pageErrors, []);
  } finally {
    await page.close();
  }
});

test("DialKit tunes, pauses, replays, and resets the ripple without changing exports", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    // Integer preview bounds avoid compositor antialiasing at the screenshot edge.
    viewport: { width: 1440, height: 1106 },
  });
  const issues = watchForBrowserErrors(page);
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    await page.getByRole("button", { name: "Ripple", exact: true }).click();
    const height = page.getByRole("slider", { name: "Height", exact: true });
    await height.press("End");
    assert.equal(Number(await height.getAttribute("aria-valuenow")), 0.8);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    await page.getByRole("button", { name: "Ripple", exact: true }).click();
    assert.equal(Number(await height.getAttribute("aria-valuenow")), 0.8, "Tuning survives reload");
    await page.locator('input[type="file"]').setInputFiles({
      name: "dialkit.png",
      mimeType: "image/png",
      buffer: await createCirclePng(page, 360, 480),
    });
    await waitForProcessedImage(page, { width: 360, height: 480 });
    const exported = await downloadPixels(page);
    await page.waitForTimeout(650);
    const flat = await page.locator("#preview").screenshot();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Paused", exact: true })
      .getByRole("radio", { name: "On", exact: true })
      .click();
    await page.waitForTimeout(150);
    const bent = await page.locator("#preview").screenshot();
    assert.notDeepEqual(bent, flat, "Paused preview must show the wave");
    assert.equal(await downloadPixels(page), exported, "Paused preview preserves PNG pixels");
    await page.waitForTimeout(650);
    assert.deepEqual(
      await page.locator("#preview").screenshot(),
      bent,
      "Export must restore the selected paused frame",
    );
    await height.press("Home");
    await page.waitForTimeout(150);
    assert.deepEqual(
      await page.locator("#preview").screenshot(),
      flat,
      "Height zero removes the bend live",
    );
    assert.equal(await downloadPixels(page), exported, "Tuning leaves PNG pixels unchanged");
    await page.getByRole("button", { name: "Reset ripple", exact: true }).click();
    assert.equal(Number(await height.getAttribute("aria-valuenow")), 0.635);
    const blur = page.getByRole("slider", { name: "Blur Px", exact: true });
    await blur.press("Home");
    await page.getByRole("button", { name: "Load impact default", exact: true }).click();
    assert.equal(Number(await blur.getAttribute("aria-valuenow")), 14);
    const savedReveal = await page.evaluate(
      () => JSON.parse(localStorage.getItem("dialkit:lukis")!).values["reveal.transition"],
    );
    assert.equal(savedReveal.duration, 1.6, "Optical default restores the approved reveal timing");
    await page.getByRole("button", { name: "Replay reveal", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>("#download")?.disabled,
    );
    await waitForProcessedImage(page, { width: 360, height: 480 });
    assert.equal(await downloadPixels(page), exported, "Replay leaves PNG pixels unchanged");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page
      .getByRole("radiogroup", { name: "Paused", exact: true })
      .getByRole("radio", { name: "On", exact: true })
      .click();
    await page.waitForTimeout(150);
    assert.deepEqual(
      await page.locator("#preview").screenshot(),
      flat,
      "Reduced motion skips paused distortion",
    );
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("DialKit experiments scrub custom timing and stop looped replay", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 1440, height: 1100 },
  });
  const issues = watchForBrowserErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "dialkit:lukis",
      JSON.stringify({
        version: 1,
        values: {
          "ripple.timing.startOffsetMs": 200,
          "ripple.timing.durationMs": 3300,
          "ripple.loop.gapMs": 100,
        },
      }),
    );
  });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    await page.locator('input[type="file"]').setInputFiles({
      name: "experiment.png",
      mimeType: "image/png",
      buffer: await createCirclePng(page, 360, 480),
    });
    await waitForProcessedImage(page, { width: 360, height: 480 });
    const exported = await downloadPixels(page);
    // Export unlocks the controls before the 600 ms hover geometry finishes.
    await page.waitForTimeout(650);
    const flat = await page.locator("#preview").screenshot();
    await page.getByRole("button", { name: "Ripple", exact: true }).click();
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    assert.equal(
      await page
        .getByRole("slider", { name: "Damping", exact: true })
        .getAttribute("aria-valuenow"),
      "0.2",
    );
    assert.equal(
      await page
        .getByRole("slider", { name: "Start Offset Ms", exact: true })
        .getAttribute("aria-valuenow"),
      "200",
    );
    assert.equal(await page.getByRole("button", { name: "Fade", exact: true }).count(), 0);
    assert.equal(await page.getByRole("slider", { name: "Fade Delay Ms", exact: true }).count(), 0);
    assert.equal(await page.getByRole("slider", { name: "Reveal Mix", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Timing", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    const paused = page.getByRole("radiogroup", { name: "Paused", exact: true });
    await paused.getByRole("radio", { name: "On", exact: true }).click();
    await page
      .getByRole("radiogroup", { name: "Use Timeline", exact: true })
      .getByRole("radio", { name: "On", exact: true })
      .click();
    await page.waitForTimeout(150);
    assert.notDeepEqual(
      await page.locator("#preview").screenshot(),
      flat,
      "Scrubbing samples custom travel",
    );
    await page.getByRole("slider", { name: "Timeline Progress", exact: true }).press("End");
    await page.waitForTimeout(150);
    assert.deepEqual(
      await page.locator("#preview").screenshot(),
      flat,
      "Timeline end restores the flat image",
    );
    assert.equal(await downloadPixels(page), exported, "Timeline scrubbing preserves exports");
    await paused.getByRole("radio", { name: "Off", exact: true }).click();
    await page.getByRole("button", { name: "Loop", exact: true }).click();
    const loop = page.getByRole("radiogroup", { name: "Enabled", exact: true });
    await loop.getByRole("radio", { name: "On", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>("#download")?.disabled,
    );
    await loop.getByRole("radio", { name: "Off", exact: true }).click();
    await waitForProcessedImage(page, { width: 360, height: 480 });
    await page.waitForTimeout(350);
    assert.ok(
      await page.locator("#download").isEnabled(),
      "Disabling Loop prevents another replay",
    );
    assert.equal(await downloadPixels(page), exported, "Looped replay preserves exports");
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        original.call(this, (blob) => setTimeout(() => callback(blob), 1200), type, quality);
      };
    });
    await loop.getByRole("radio", { name: "On", exact: true }).click();
    assert.equal(await downloadPixels(page), exported, "Slow export preserves PNG pixels");
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>("#download")?.disabled,
      undefined,
      { timeout: 2000 },
    );
    await loop.getByRole("radio", { name: "Off", exact: true }).click();
    await waitForProcessedImage(page, { width: 360, height: 480 });
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
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
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
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

test("keeps revealed image pixels undistorted during the bounds and reveal overlap", async () => {
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
      "dialkit:lukis",
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
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
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
      `the rendered circle distorted during overlap: ${JSON.stringify({
        finalSample,
        overlapSamples,
      })}`,
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

test("reveals without a CSS mask or zoom during bounds overlap", async () => {
  const context = await getBrowser().newContext({
    reducedMotion: "no-preference",
    viewport: { width: 1280, height: 960 },
  });
  await context.addInitScript(() => {
    const values = {
      "bounds.transition": {
        type: "easing",
        duration: 1,
        ease: [1, -0.4, 0.35, 0.95],
      },
      "reveal.transition": {
        type: "easing",
        duration: 0.3,
        ease: [0.22, 1, 0.36, 1],
      },
    };
    localStorage.setItem(
      "dialkit:lukis",
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
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const expected = { height: 480, width: 360 };
    const fixture = await createCirclePng(page, expected.width, expected.height);
    const samples = await captureRevealCenterSamples(page, expected, () =>
      page.locator('input[type="file"]').setInputFiles({
        name: "centered-reveal.png",
        mimeType: "image/png",
        buffer: fixture,
      }),
    );

    assert.ok(samples.length >= 3, `expected reveal samples, received ${samples.length}`);
    assert.ok(
      samples.every(
        ({ frameMask, imageMask, revealTransform }) =>
          frameMask === "none" && imageMask === "none" && revealTransform === "none",
      ),
    );
    assertNoBrowserErrors(issues);
  } finally {
    await context.close();
  }
});

for (const scenario of [
  { name: "linear", ease: [0, 0, 1, 1], reduced: false },
  { name: "shorter reveal", ease: [0, 0, 1, 1], reduced: false },
  { name: "late easing", ease: [1, 0.07, 1, 0.37], reduced: false },
  { name: "reduced motion", ease: [0, 0, 1, 1], reduced: true },
]) {
  test(`reveal honors DialKit timing with ${scenario.name}`, async () => {
    const context = await getBrowser().newContext({
      reducedMotion: scenario.reduced ? "reduce" : "no-preference",
      viewport: { width: 800, height: 700 },
    });
    await context.addInitScript(({ ease, name }) => {
      const values = {
        "bounds.transition": { type: "easing", duration: 2, ease: [0, 0, 1, 1] },
        "reveal.transition": {
          type: "easing",
          duration: name === "shorter reveal" ? 0.6 : 2,
          ease,
        },
      };
      localStorage.setItem(
        "dialkit:lukis",
        JSON.stringify({
          version: 1,
          values,
          baseValues: values,
          activePresetId: null,
        }),
      );
    }, scenario);
    const page = await context.newPage();
    const issues = watchForBrowserErrors(page);
    try {
      await page.goto(baseUrl);
      await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
      await page.locator('input[type="file"]').setInputFiles({
        name: "timing.png",
        mimeType: "image/png",
        buffer: await createSplitColorPng(page, 80, 60),
      });
      const samples = await page.evaluate(
        () =>
          new Promise<
            {
              elapsed: number;
              opacity: number;
              progress: number;
              filter: string;
            }[]
          >((resolve) => {
            const frames: {
              elapsed: number;
              opacity: number;
              progress: number;
              filter: string;
            }[] = [];
            let start: number | undefined;
            function sample() {
              // The rAF timestamp can precede this callback by startup/GPU work.
              // Measure the DOM styles against the time they are actually read.
              const now = performance.now();
              const clip = document.querySelector(".canvas-clip");
              if (clip?.getAttribute("aria-hidden") === "false") {
                start ??= now;
                const style = getComputedStyle(clip);
                const value = {
                  elapsed: now - start,
                  opacity: Number(style.opacity),
                  progress: Number((clip as HTMLElement).dataset.revealProgress ?? 1),
                  filter: getComputedStyle(clip.querySelector(".canvas-surface")!).filter,
                };
                frames.push(value);
                if ((value.opacity >= 0.999 && value.progress >= 0.999) || value.elapsed > 3000) {
                  resolve(frames);
                  return;
                }
              }
              requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
          }),
      );
      assert.ok(samples.every(({ progress }) => progress >= 0 && progress <= 1));
      const last = samples.at(-1)!;
      assert.ok(last.opacity >= 0.999 && last.progress >= 0.999);
      if (scenario.reduced) {
        assert.ok(
          last.elapsed < 250,
          `reduced fade took ${last.elapsed}ms: ${JSON.stringify(samples)}`,
        );
        assert.ok(
          samples.every(
            ({ progress, filter }) => Math.abs(progress - 1) < 0.001 && filter === "blur(0px)",
          ),
        );
      } else {
        assert.ok(
          samples.every(({ opacity }) => opacity === 1),
          "The shader mask owns visibility; clip opacity must not weaken the ripple",
        );
        assert.ok(last.elapsed > 1700 && last.elapsed < 2600, `2s reveal took ${last.elapsed}ms`);
        const middle = samples.find(({ elapsed }) => elapsed >= 900)!;
        assert.ok(middle, "expected an intermediate animation frame");
        if (scenario.name === "shorter reveal") {
          assert.equal(middle.progress, 0);
          const revealing = samples.find(({ elapsed }) => elapsed >= 1650)!;
          assert.ok(
            revealing.progress > 0 && revealing.progress < 1,
            `short reveal samples: ${JSON.stringify({ first: samples[0], middle, revealing, last })}`,
          );
          assert.equal(revealing.filter, "blur(0px)", "Localized blur belongs to the shader");
        } else if (scenario.name === "linear")
          assert.ok(
            middle.progress > 0.35 && middle.progress < 0.65,
            `linear reveal samples: ${JSON.stringify({ first: samples[0], middle, last })}`,
          );
        else assert.ok(middle.progress < 0.3, `late easing was ${middle.progress} at 900ms`);
      }
      assertNoBrowserErrors(issues);
    } finally {
      await context.close();
    }
  });
}

test("hidden controls do not flash or focus and sliders preserve pointer ownership", async () => {
  const context = await getBrowser().newContext({ reducedMotion: "no-preference" });
  await context.addInitScript(() => {
    const values = {
      "bounds.transition": { type: "easing", duration: 2, ease: [0, 0, 1, 1] },
    };
    localStorage.setItem(
      "dialkit:lukis",
      JSON.stringify({ version: 1, values, baseValues: values, activePresetId: null }),
    );
  });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.evaluate(() => {
      const controls = document.querySelector<HTMLElement>(".controls")!;
      const controlsSpace = document.querySelector<HTMLElement>(".controls-space")!;
      const observer = new MutationObserver(() => {
        if (controlsSpace.hidden) return;
        controls.dataset.initialRowOpacities = JSON.stringify(
          [...controls.children].map((row) => Number(getComputedStyle(row).opacity)),
        );
        observer.disconnect();
      });
      observer.observe(controlsSpace, { attributes: true, attributeFilter: ["hidden"] });
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "controls.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 80, 60),
    });
    const paint = page.getByRole("slider", { name: "Paint", exact: true, includeHidden: true });
    await paint.waitFor({ state: "attached" });
    assert.equal(
      await paint.evaluate((element) => {
        (element as HTMLElement).focus();
        return document.activeElement === element;
      }),
      false,
    );
    await page.waitForFunction(() => !document.querySelector(".controls")?.hasAttribute("inert"));
    const initialRowOpacities = JSON.parse(
      (await page.locator(".controls").getAttribute("data-initial-row-opacities"))!,
    ) as number[];
    assert.ok(initialRowOpacities.length > 0);
    assert.ok(
      initialRowOpacities.every((opacity) => opacity === 0),
      "Control rows must be transparent when unhidden, before the first reveal GPU frame completes",
    );
    await paint.focus();
    await paint.press("Home");
    assert.equal(await paint.getAttribute("aria-valuenow"), "0");
    assert.ok(
      (await paint.evaluate((element) =>
        parseFloat(
          getComputedStyle(element.querySelector('[data-slot="elastic-slider-fill"]')!).width,
        ),
      )) < 1,
    );
    await waitForProcessedImage(page, { width: 80, height: 60 });
    const rect = (await paint.boundingBox())!;
    const touch = (id: number, fraction: number) => ({
      id,
      x: rect.x + rect.width * fraction,
      y: rect.y + 10,
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touch(1, 0.2)],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touch(1, 0.3)] });
    const firstValue = await paint.getAttribute("aria-valuenow");
    assert.notEqual(firstValue, "0");
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [touch(1, 0.3), touch(2, 0.8)],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touch(1, 0.3), touch(2, 0.9)],
    });
    assert.equal(await paint.getAttribute("aria-valuenow"), firstValue);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touch(1, 0.5), touch(2, 0.9)],
    });
    await page.waitForFunction(
      (previous) =>
        document
          .querySelector('[role="slider"][aria-label="Paint"]')
          ?.getAttribute("aria-valuenow") !== previous,
      firstValue,
    );
    assert.notEqual(await paint.getAttribute("aria-valuenow"), firstValue);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await context.close();
  }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`NumberFlow preserves slider values and motion preferences (${reducedMotion})`, async () => {
    const page = await getBrowser().newPage({
      reducedMotion,
      viewport: { width: 320, height: 720 },
    });
    const issues = watchForBrowserErrors(page);
    try {
      await page.goto(baseUrl);
      await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
      await page.locator('input[type="file"]').setInputFiles({
        name: "numbers.png",
        mimeType: "image/png",
        buffer: await createSplitColorPng(page, 64, 48),
      });
      await waitForProcessedImage(page, { width: 64, height: 48 });
      const initial = await page.evaluate(() =>
        [...document.querySelectorAll("number-flow")].map((flow) => ({
          value: flow.value,
          suffix: flow.numberSuffix,
          decimals: flow.format?.minimumFractionDigits,
          shadow: !!flow.shadowRoot,
        })),
      );
      assert.deepEqual(initial, [
        { value: 78, suffix: "%", decimals: 0, shadow: true },
        { value: 1.4, suffix: "", decimals: 1, shadow: true },
      ]);
      const paint = page.getByRole("slider", { name: "Paint" });
      await paint.focus();
      const state = await paint.evaluate(async (slider) => {
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        const flow = slider.querySelector("number-flow")!;
        let animated = false;
        const start = performance.now();
        while (performance.now() - start < 180) {
          animated ||= [...flow.shadowRoot!.querySelectorAll("*")].some((node) =>
            node.getAnimations().some((animation) => animation.playState === "running"),
          );
          // oxlint-disable-next-line no-await-in-loop
          await new Promise(requestAnimationFrame);
        }
        return { animated, value: flow.value, text: slider.getAttribute("aria-valuetext") };
      });
      assert.equal(state.value, 100);
      assert.equal(state.text, "100%");
      assert.equal(state.animated, reducedMotion === "no-preference");
      const brush = page.getByRole("slider", { name: "Brush" });
      await brush.press("End");
      assert.equal(await brush.getAttribute("aria-valuetext"), "3.0");
      await brush.press("Home");
      assert.equal(await brush.getAttribute("aria-valuetext"), "0.7");
      await paint.press("Home");
      await paint.press("Shift+ArrowRight");
      assert.equal(await paint.getAttribute("aria-valuetext"), "10%");
      await page.waitForFunction(() =>
        [...document.querySelectorAll("number-flow")].every((flow) =>
          [...flow.shadowRoot!.querySelectorAll("*")].every((node) =>
            node.getAnimations().every((animation) => animation.playState !== "running"),
          ),
        ),
      );
      const flows = await page.evaluate(() =>
        [...document.querySelectorAll("number-flow")].map((node) => node.value),
      );
      assert.deepEqual(flows, [10, 0.7]);
      assertNoBrowserErrors(issues);
    } finally {
      await page.close();
    }
  });
}

test("tunes, downloads, and restarts a processed image", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 960 },
  });
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
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
    assert.equal(download.suggestedFilename(), "controls-lukis.png");
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

test("clears the image in half the duration of the returning bounds", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 1280, height: 960 },
  });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 64, 128),
    });
    await waitForProcessedImage(page, { width: 64, height: 128 });
    const frames = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLElement>(".canvas-frame")!;
      const startWidth = frame.getBoundingClientRect().width;
      const endWidth = document.querySelector(".preview-stage")!.getBoundingClientRect().width;
      const samples = [];
      document
        .querySelector<HTMLButtonElement>('[aria-label="Restart with another image"]')!
        .click();
      const start = performance.now();
      while (performance.now() - start < 3000) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const progress = Math.max(
          0,
          Math.min(1, (frame.getBoundingClientRect().width - startWidth) / (endWidth - startWidth)),
        );
        const outgoing = document.querySelector(".outgoing-image")!;
        const opacity = Number(getComputedStyle(outgoing).opacity);
        const filter = getComputedStyle(outgoing).filter;
        samples.push({
          time: performance.now() - start,
          progress,
          opacity,
          blur: Number(filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0),
          controlsExiting: frame.hasAttribute("data-has-file"),
        });
        if (
          !frame.hasAttribute("data-has-file") &&
          frame.dataset.animating !== "true" &&
          opacity === 0
        )
          break;
      }
      return samples;
    });
    assert.ok(
      frames.some((frame) => frame.controlsExiting),
      "Observe the controls exit first.",
    );
    assert.ok(
      frames.filter((frame) => frame.controlsExiting).every((frame) => frame.opacity === 1),
      "Keep the image visible until the bounds begin returning.",
    );
    const moving = frames.filter((frame) => frame.opacity > 0.05 && frame.opacity < 0.95);
    assert.ok(moving.length > 2, "Observe the image fading out.");
    const boundsStart = frames.find((frame) => !frame.controlsExiting)!.time;
    const fadeEnd = frames.find((frame) => !frame.controlsExiting && frame.opacity === 0)!.time;
    const boundsEnd = frames.at(-1)!.time;
    assert.ok(
      Math.abs((fadeEnd - boundsStart) / (boundsEnd - boundsStart) - 0.5) < 0.08,
      "The image exit must take half the bounds duration.",
    );
    assert.ok(
      moving.every((frame) => Math.abs(frame.blur / 4 - (1 - frame.opacity)) < 0.04),
      "Image blur and opacity must stay synchronized.",
    );
    assert.equal(frames.at(-1)?.opacity, 0);
    await assertUploadStateRestored(page);
  } finally {
    await page.close();
  }
});

test("ignores a dropped replacement while Restart is exiting", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 1280, height: 960 },
  });
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "initial.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 64, 48),
    });
    await waitForProcessedImage(page, { height: 48, width: 64 });
    const replacement = Array.from(await createSplitColorPng(page, 48, 64));

    await page.evaluate((bytes) => {
      const browserWindow = window as typeof window & {
        replacementDecodeCount: number;
      };
      const originalCreateImageBitmap = window.createImageBitmap;
      browserWindow.replacementDecodeCount = 0;
      const trackedCreateImageBitmap = async (...arguments_: unknown[]) => {
        browserWindow.replacementDecodeCount += 1;
        return Reflect.apply(originalCreateImageBitmap, window, arguments_) as Promise<ImageBitmap>;
      };
      window.createImageBitmap = trackedCreateImageBitmap as typeof window.createImageBitmap;

      const restart = document.querySelector<HTMLButtonElement>(
        '[aria-label="Restart with another image"]',
      );
      const dropzone = document.querySelector(".image-bounds");
      if (!restart || !dropzone) throw new Error("Restart controls are unavailable.");

      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "replacement.png", {
          type: "image/png",
        }),
      );
      restart.click();
      dropzone.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    }, replacement);

    await assertUploadStateRestored(page);
    assert.equal(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              replacementDecodeCount: number;
            }
          ).replacementDecodeCount,
      ),
      0,
    );
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`keeps controls aligned and visible while replacement bounds resize (${reducedMotion})`, async () => {
    const page = await getBrowser().newPage({
      reducedMotion,
      viewport: { width: 1280, height: 960 },
    });
    const issues = watchForBrowserErrors(page);

    try {
      await page.goto(baseUrl);
      await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
      await page.locator('input[type="file"]').setInputFiles({
        name: "wide.png",
        mimeType: "image/png",
        buffer: await createSplitColorPng(page, 128, 64),
      });
      await waitForProcessedImage(page, { width: 128, height: 64 });
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".control-row, .control-actions")].every(
          (row) => getComputedStyle(row).opacity === "1",
        ),
      );

      const width = 64;
      const height = 128;
      const bytes = Array.from(await createSplitColorPng(page, width, height));
      await page.locator(".image-bounds").dispatchEvent("dragenter");
      await page.waitForFunction(
        () => Number(getComputedStyle(document.querySelector(".message-chrome")!).opacity) === 1,
      );
      const samples = await page.evaluate(async (png) => {
        const frames: {
          time: number;
          widthError: number;
          gap: number;
          opacity: number;
          width: number;
          hasUploadInstructions: boolean;
        }[] = [];
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(png)], "replacement.png", { type: "image/png" }),
        );
        document
          .querySelector(".image-bounds")!
          .dispatchEvent(
            new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
          );
        const start = performance.now();
        let loadedAt: number | undefined;
        while (performance.now() - start < 6000) {
          // Sample rendered frames in order, after Motion's frame callbacks.
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => setTimeout(resolve, 0));
          });
          const frame = document.querySelector(".canvas-frame")!.getBoundingClientRect();
          const controls = document.querySelector(".controls")!.getBoundingClientRect();
          frames.push({
            time: performance.now() - start,
            widthError: Math.abs(frame.width - controls.width),
            gap: controls.top - frame.bottom,
            opacity: Math.min(
              ...[...document.querySelectorAll(".control-row, .control-actions")].map((row) =>
                Number(getComputedStyle(row).opacity),
              ),
            ),
            width: controls.width,
            hasUploadInstructions:
              document.querySelector<HTMLElement>("#image-requirements")?.checkVisibility() ===
                true ||
              [...document.querySelectorAll("[data-message-text]")].some((text) =>
                text.textContent?.includes("Turn an image into a painting"),
              ),
          });
          const canvas = document.querySelector("canvas")!;
          if (loadedAt === undefined && canvas.width === 64 && canvas.height === 128) {
            loadedAt = performance.now();
          }
          if (loadedAt !== undefined && performance.now() - loadedAt >= 1400) break;
        }
        if (loadedAt === undefined) throw new Error("The replacement did not finish decoding.");
        return frames;
      }, bytes);

      assert.ok(samples.length > 10);
      assert.ok(
        samples.every((sample) => !sample.hasUploadInstructions),
        "Replacement must not flash first-upload instructions during decoding or reveal.",
      );
      assert.ok(
        samples.every((sample) => sample.widthError < 1),
        `Controls must follow the visible frame width (${reducedMotion}: ${JSON.stringify(samples.filter((sample) => sample.widthError >= 1))}).`,
      );
      assert.ok(
        samples.every((sample) => Math.abs(sample.gap - 32) < 1),
        `Controls must keep their gap below the moving frame (${reducedMotion}: ${Math.min(...samples.map((sample) => sample.gap))}–${Math.max(...samples.map((sample) => sample.gap))}px).`,
      );
      assert.ok(
        samples.every((sample) => sample.opacity === 1),
        "Replacement must not replay the controls entrance.",
      );
      if (reducedMotion === "no-preference") {
        assert.ok(
          new Set(samples.map((sample) => Math.round(sample.width))).size > 10,
          "The width must pass through intermediate sizes.",
        );
      } else {
        assert.ok(
          new Set(samples.map((sample) => Math.round(sample.width))).size <= 2,
          "Reduced motion must switch directly between the old and new widths.",
        );
      }
      await waitForProcessedImage(page, { width, height });
      assertNoBrowserErrors(issues);
    } finally {
      await page.close();
    }
  });
}

for (const [method, reducedMotion] of [
  ["drop", "no-preference"],
  ["input", "no-preference"],
  ["input", "reduce"],
] as const) {
  test(`crossfades the outgoing image on ${method} replacement (${reducedMotion})`, async () => {
    const page = await getBrowser().newPage({
      reducedMotion,
      viewport: { width: 1280, height: 960 },
    });
    const issues = watchForBrowserErrors(page);
    try {
      await page.goto(baseUrl);
      await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
      await page.locator('input[type="file"]').setInputFiles({
        name: "old.png",
        mimeType: "image/png",
        buffer: await createSplitColorPng(page, 128, 64),
      });
      await waitForProcessedImage(page, { width: 128, height: 64 });
      if (method === "drop") {
        await page.locator(".image-bounds").dispatchEvent("dragenter");
        await page.waitForFunction(() => {
          const style = getComputedStyle(document.querySelector(".canvas-surface canvas")!);
          return Number(style.opacity) === Number(style.getPropertyValue("--monochrome-opacity"));
        });
      }
      const png = Array.from(await createCirclePng(page, 64, 128));
      const exportedPixels = await downloadPixels(page);
      const result = await page.evaluate(
        async ({ bytes, method: uploadMethod, exportedPixels: exportedImage }) => {
          const current = document.querySelector<HTMLCanvasElement>(".canvas-surface canvas")!;
          const expectedPixels = exportedImage;
          const appearance = getComputedStyle(current);
          const expected = {
            opacity: appearance.opacity,
            filter: appearance.filter,
            mask: appearance.maskImage,
            maskComposite: appearance.maskComposite,
          };
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array(bytes)], "new.png", { type: "image/png" }));
          // Keep the loading phase observable even on fast machines.
          const decode = window.createImageBitmap;
          window.createImageBitmap = (async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return Reflect.apply(decode, window, args);
          }) as typeof window.createImageBitmap;
          if (uploadMethod === "drop") {
            document
              .querySelector(".image-bounds")!
              .dispatchEvent(
                new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
              );
          } else {
            const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
            input.files = transfer.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const outgoing = document.querySelector<HTMLCanvasElement>(".outgoing-image canvas")!;
          // The cached GPU texture is read asynchronously before replacement decoding starts.
          await new Promise<void>((resolve) => {
            const ready = () => (outgoing.width > 0 ? resolve() : requestAnimationFrame(ready));
            ready();
          });
          const preservedPixels = outgoing.toDataURL() === expectedPixels;
          const preservedAppearance =
            outgoing.style.opacity === expected.opacity &&
            outgoing.style.filter === expected.filter &&
            outgoing.style.maskImage === expected.mask &&
            getComputedStyle(outgoing).maskComposite === expected.maskComposite;
          const frames = [];
          const start = performance.now();
          let loadedAt: number | undefined;
          while (performance.now() - start < 6000) {
            // oxlint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => setTimeout(resolve, 0)),
            );
            const old = getComputedStyle(document.querySelector(".outgoing-image")!);
            const bounds = document.querySelector(".image-bounds")!.getBoundingClientRect();
            const overlay = document.querySelector(".outgoing-bounds")!.getBoundingClientRect();
            frames.push({
              oldOpacity: Number(old.opacity),
              blur: Number(old.filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0),
              newOpacity: Number(getComputedStyle(document.querySelector(".canvas-clip")!).opacity),
              boundsError: Math.max(
                Math.abs(bounds.left - overlay.left),
                Math.abs(bounds.width - overlay.width),
                Math.abs(bounds.height - overlay.height),
              ),
              loaded: current.width === 64,
            });
            if (current.width === 64 && loadedAt === undefined) loadedAt = performance.now();
            if (loadedAt !== undefined && outgoing.width === 0) break;
          }
          return { preservedPixels, preservedAppearance, frames, released: outgoing.width === 0 };
        },
        { bytes: png, method, exportedPixels },
      );
      assert.ok(
        result.preservedPixels,
        "Keep the outgoing pixels before replacing the GPU texture.",
      );
      assert.ok(result.preservedAppearance, "Keep the outgoing color or monochrome treatment.");
      assert.ok(
        result.frames.some((frame) => !frame.loaded && frame.oldOpacity === 1),
        "Hold the old image during decoding.",
      );
      if (reducedMotion === "reduce") {
        assert.ok(
          result.frames.every((frame) => frame.blur === 0),
          "Reduced motion skips blur.",
        );
      } else {
        assert.ok(
          result.frames.some(
            (frame) =>
              frame.oldOpacity > 0.05 &&
              frame.oldOpacity < 0.95 &&
              frame.newOpacity > 0.05 &&
              frame.blur > 0,
          ),
          "The old and new images must overlap while the old image blurs.",
        );
      }
      assert.ok(
        result.frames.every((frame) => frame.boundsError < 1),
        "Clip the outgoing image to the moving bounds.",
      );
      assert.ok(result.released, "Release the temporary image after the crossfade.");
      await waitForProcessedImage(page, { width: 64, height: 128 });
      assertNoBrowserErrors(issues);
    } finally {
      await page.close();
    }
  });
}

test("keeps a valid replacement when a rapid invalid drop follows it", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 960 },
  });
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "initial.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 64, 48),
    });
    await waitForProcessedImage(page, { height: 48, width: 64 });
    const replacement = Array.from(await createSplitColorPng(page, 48, 64));

    await page.evaluate((bytes) => {
      const originalCreateImageBitmap = window.createImageBitmap;
      const delayedCreateImageBitmap = async (...arguments_: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return Reflect.apply(originalCreateImageBitmap, window, arguments_) as Promise<ImageBitmap>;
      };
      window.createImageBitmap = delayedCreateImageBitmap as typeof window.createImageBitmap;

      const dropzone = document.querySelector(".image-bounds");
      if (!dropzone) throw new Error("The upload surface is unavailable.");
      const drop = (file: File) => {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        dropzone.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      };

      drop(new File([new Uint8Array(bytes)], "replacement.png", { type: "image/png" }));
      setTimeout(() => {
        drop(new File(["invalid"], "invalid.txt", { type: "text/plain" }));
      }, 20);
    }, replacement);

    await waitForProcessedImage(page, { height: 64, width: 48 });
    assert.equal(await page.locator('.message-chrome[data-error="true"]').count(), 0);
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
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
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

async function assertErrorChrome(page: Page, message: string): Promise<void> {
  await page.waitForFunction((expected) => {
    const chrome = document.querySelector('.message-chrome[data-error="true"]');
    return (
      chrome instanceof HTMLElement &&
      Number.parseFloat(getComputedStyle(chrome).opacity) >= 0.99 &&
      Array.from(chrome.querySelectorAll("[data-message-text]")).some(
        (text) => text.textContent === expected && Number(getComputedStyle(text).opacity) >= 0.99,
      ) &&
      document.querySelector('[aria-live="polite"]')?.textContent === expected
    );
  }, message);
}

test("keeps the monochrome reference still while a dropped image decodes", async () => {
  const page = await getBrowser().newPage({ colorScheme: "dark", reducedMotion: "no-preference" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const bytes = Array.from(await createSplitColorPng(page, 360, 640));
    await page.mouse.move(0, 0);
    const reference = page.locator(".dropzone-reference");
    await page.locator(".dropzone").dispatchEvent("dragenter");
    await page.waitForFunction(() => {
      const element = document.querySelector(".dropzone-reference");
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.opacity === "0.24" && style.transform === "none";
    });
    await page.evaluate((png) => {
      const original = window.createImageBitmap;
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const testWindow = window as Window & { releaseDecode?: () => void };
      testWindow.releaseDecode = () => {
        window.createImageBitmap = original;
        release();
        delete testWindow.releaseDecode;
      };
      window.createImageBitmap = (async (...args: unknown[]) => {
        await gate;
        return Reflect.apply(original, window, args);
      }) as typeof createImageBitmap;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(png)], "portrait.png", { type: "image/png" }));
      document
        .querySelector(".dropzone")!
        .dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
    }, bytes);
    await page.waitForTimeout(350);
    assert.deepEqual(
      await reference.evaluate((element) => ({
        opacity: getComputedStyle(element).opacity,
        transform: getComputedStyle(element).transform,
      })),
      { opacity: "0.24", transform: "none" },
    );
    await page.evaluate(() =>
      (window as Window & { releaseDecode?: () => void }).releaseDecode?.(),
    );
    await waitForProcessedImage(page, { width: 360, height: 640 });
  } finally {
    await page.close();
  }
});

for (const viewport of [
  { width: 1490, height: 927 },
  { width: 390, height: 844 },
]) {
  test(`keeps the reference centered during upload overshoot at ${viewport.width}px`, async () => {
    const page = await getBrowser().newPage({
      viewport,
      colorScheme: "dark",
      reducedMotion: "no-preference",
    });
    try {
      await page.goto(baseUrl);
      await page.waitForFunction(
        () => !document.querySelector<HTMLButtonElement>(".dropzone")!.disabled,
      );
      const bytes = Array.from(await createSplitColorPng(page, 360, 640));
      await page.locator(".dropzone").hover();
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector(".dropzone-reference")!).transform === "none",
      );
      const samples = await page.evaluate(async (png) => {
        const reference = document.querySelector(".dropzone-reference")!;
        const frame = document.querySelector(".canvas-frame")!;
        const initial = reference.getBoundingClientRect();
        const center = initial.x + initial.width / 2;
        const width = frame.getBoundingClientRect().width;
        const frames: { offset: number; width: number }[] = [];
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(png)], "portrait.png", { type: "image/png" }));
        const input = document.querySelector<HTMLInputElement>("#image-input")!;
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const start = performance.now();
        while (performance.now() - start < 6000) {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
          const bounds = reference.getBoundingClientRect();
          frames.push({
            offset: bounds.x + bounds.width / 2 - center,
            width: frame.getBoundingClientRect().width,
          });
          if (!input.disabled) break;
        }
        return { frames, width };
      }, bytes);
      assert.ok(
        samples.frames.some((sample) => sample.width > samples.width + 1),
        "Capture the initial bounds overshoot.",
      );
      const maxOffset = Math.max(...samples.frames.map((sample) => Math.abs(sample.offset)));
      assert.ok(
        maxOffset < 1,
        `The reference must stay centered through overshoot; drift was ${maxOffset}px.`,
      );
      await waitForProcessedImage(page, { width: 360, height: 640 });
    } finally {
      await page.close();
    }
  });
}

test("keeps upload chrome centered while a tall image reveals", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 1490, height: 927 },
  });
  const issues = watchForBrowserErrors(page);
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const bytes = Array.from(await createSplitColorPng(page, 1086, 1448));
    await page.locator(".image-bounds").hover();
    const samples = await page.evaluate(async (png) => {
      const frames: {
        opacity: number;
        iconOffset: number;
        textOffset: number;
        iconWidth: number;
      }[] = [];
      const initialBounds = document.querySelector(".image-bounds")!.getBoundingClientRect();
      const center = initialBounds.left + initialBounds.width / 2;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(png)], "tall.png", { type: "image/png" }));
      document
        .querySelector(".image-bounds")!
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      const start = performance.now();
      while (performance.now() - start < 6000) {
        // Include the first visible frame after layout, not only the settled fade.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const chrome = document.querySelector(".message-chrome")!;
        const icon = chrome.querySelector("[data-message-icon]")!.getBoundingClientRect();
        const text = chrome.querySelector("[data-message-text]")!.getBoundingClientRect();
        const opacity = Number(getComputedStyle(chrome).opacity);
        frames.push({
          opacity,
          iconOffset: Math.abs(icon.left + icon.width / 2 - center),
          textOffset: Math.abs(text.left + text.width / 2 - center),
          iconWidth: icon.width,
        });
        if (opacity === 0) break;
      }
      return frames;
    }, bytes);
    const visibleFrames = samples.filter((sample) => sample.opacity > 0.02);
    assert.ok(visibleFrames.length > 2, "Capture the fading chrome, including its first frame.");
    assert.ok(
      samples.some((sample) => sample.opacity === 0),
      "The chrome must finish fading.",
    );
    assert.ok(
      visibleFrames.every((sample) => sample.iconOffset < 1 && sample.textOffset < 1),
      `The fading chrome must keep its initial horizontal center: ${JSON.stringify(visibleFrames)}.`,
    );
    assert.ok(
      visibleFrames.every((sample) => Math.abs(sample.iconWidth - 36) < 1),
      "The icon must not stretch with the bounds.",
    );
    await waitForProcessedImage(page, { width: 1086, height: 1448 });
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("fades the mobile monogram with upload bounds and restores it after restart", async () => {
  const page = await getBrowser().newPage({
    reducedMotion: "no-preference",
    viewport: { width: 565, height: 948 },
  });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const monogram = page.locator(".dropzone-monogram").locator("..");
    assert.equal(await monogram.evaluate((element) => getComputedStyle(element).opacity), "1");
    await page.locator('input[type="file"]').setInputFiles({
      name: "wide.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 128, 64),
    });
    await page.waitForFunction(() => {
      const opacity = Number(
        getComputedStyle(document.querySelector(".dropzone-monogram")!.parentElement!).opacity,
      );
      return opacity > 0 && opacity < 1;
    });
    await waitForProcessedImage(page, { width: 128, height: 64 });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".dropzone-monogram")!.parentElement!).opacity ===
        "0",
    );
    await page.getByRole("button", { name: "Restart with another image" }).click();
    await assertUploadStateRestored(page);
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".dropzone-monogram")!.parentElement!).opacity ===
        "1",
    );
  } finally {
    await page.close();
  }
});

test("wraps processing errors inside narrow portrait bounds", async () => {
  const page = await getBrowser().newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 360, 640),
    });
    await waitForProcessedImage(page, { width: 360, height: 640 });
    await page.locator('input[type="file"]').setInputFiles({
      name: "corrupt.png",
      mimeType: "image/png",
      buffer: Buffer.from("not a PNG"),
    });
    await assertErrorChrome(page, "That image could not be processed. Try another file.");
    await page.waitForFunction(() => {
      const bounds = document.querySelector(".image-bounds")!.getBoundingClientRect();
      const text = document.querySelector('[data-message-text][data-error="true"]');
      if (!text) return false;
      const range = document.createRange();
      range.selectNodeContents(text);
      return Array.from(range.getClientRects()).every(
        (rect) => rect.left >= bounds.left && rect.right <= bounds.right,
      );
    });
  } finally {
    await page.close();
  }
});

test("reports invalid files and keeps upload recovery available", async () => {
  const page = await getBrowser().newPage();
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "animation.gif",
      mimeType: "image/gif",
      buffer: Buffer.from("GIF89a"),
    });

    await assertErrorChrome(page, "Choose a PNG, JPEG, or WebP image.");
    await assertUploadStateRestored(page);
    await page.waitForFunction(
      () => {
        const text = document.querySelector("[data-message-text]");
        return (
          !document.querySelector('.message-chrome[data-error="true"]') &&
          text?.textContent === "Turn an image into a painting" &&
          Number(getComputedStyle(text).opacity) >= 0.99 &&
          document.querySelector(".status")?.textContent === ""
        );
      },
      undefined,
      { timeout: 7_000 },
    );
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("repeating the same error restarts its display time", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "reduce" });
  const invalidFile = {
    name: "invalid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("invalid"),
  };
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const input = page.locator('input[type="file"]');
    await input.setInputFiles(invalidFile);
    await assertErrorChrome(page, "Choose a PNG, JPEG, or WebP image.");
    await page.waitForTimeout(3_000);
    await input.setInputFiles(invalidFile);
    await page.waitForTimeout(3_000);
    await assertErrorChrome(page, "Choose a PNG, JPEG, or WebP image.");
    await page.waitForFunction(
      () => !document.querySelector('.message-chrome[data-error="true"]'),
      undefined,
      { timeout: 3_000 },
    );
  } finally {
    await page.close();
  }
});

test("monochrome styling follows the theme without changing the full-color image", async () => {
  const page = await getBrowser().newPage({ colorScheme: "light", reducedMotion: "no-preference" });
  const issues = watchForBrowserErrors(page);
  const expectMonochrome = async (selector: string, opacity: string, filter: string) => {
    await page.waitForFunction(
      (expected) => {
        const element = document.querySelector(expected.selector);
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.opacity === expected.opacity && style.filter === expected.filter;
      },
      { selector, opacity, filter },
    );
  };
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator(".dropzone").dispatchEvent("dragenter");
    await expectMonochrome(
      ".dropzone-reference",
      "0.16",
      "grayscale(1) brightness(1) contrast(0.9)",
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await expectMonochrome(
      ".dropzone-reference",
      "0.24",
      "grayscale(1) brightness(0.38) contrast(1.15)",
    );
    await page.locator(".dropzone").dispatchEvent("dragleave");
    await page.locator('input[type="file"]').setInputFiles({
      name: "theme-fixture.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 360, 480),
    });
    await waitForProcessedImage(page, { width: 360, height: 480 });
    const canvas = ".canvas-surface canvas";
    await expectMonochrome(canvas, "1", "grayscale(0) brightness(1) contrast(1)");
    await page.locator(".dropzone").dispatchEvent("dragenter");
    await expectMonochrome(canvas, "0.24", "grayscale(1) brightness(0.38) contrast(1.15)");
    await page.emulateMedia({ colorScheme: "light" });
    await expectMonochrome(canvas, "0.16", "grayscale(1) brightness(1) contrast(0.9)");
    await page.locator(".dropzone").dispatchEvent("dragleave");
    await expectMonochrome(canvas, "1", "grayscale(0) brightness(1) contrast(1)");
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("theme control cycles, persists, and follows the system only in System mode", async () => {
  const page = await getBrowser().newPage({
    colorScheme: "dark",
    reducedMotion: "no-preference",
    viewport: { width: 800, height: 700 },
  });
  const issues = watchForBrowserErrors(page);
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const control = page.getByRole("button", { name: /^Theme:/ });
    await control.waitFor();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    assert.match((await control.getAttribute("aria-label"))!, /System/);
    const rect = (await control.boundingBox())!;
    assert.ok(rect.x >= 0 && rect.x < 40 && rect.y > 630 && rect.y + rect.height <= 700);
    const darkBackground = await page
      .locator(".ds-root")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await control.click();
    await page.waitForFunction(() => document.documentElement.classList.contains("light"));
    await page.waitForFunction(
      (previousColor) =>
        getComputedStyle(document.querySelector(".ds-root")!).backgroundColor !== previousColor,
      darkBackground,
    );
    const lightBackground = await page
      .locator(".ds-root")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.notEqual(lightBackground, darkBackground);
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    assert.ok(
      await page.locator("html").evaluate((element) => element.classList.contains("light")),
    );
    await page.reload();
    await control.waitFor();
    await page.waitForFunction(() =>
      document.querySelector('button[aria-label="Theme: Light. Switch to Dark"]'),
    );
    await control.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await control.press("Space");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "system");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.classList.contains("light"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    assert.match((await control.getAttribute("aria-label"))!, /System/);
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("theme colors crossfade for 180ms, but not on mount or with reduced motion", async () => {
  const page = await getBrowser().newPage({ colorScheme: "dark", reducedMotion: "no-preference" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page
      .getByRole("button", { name: "Theme: System. Switch to Light", exact: true })
      .waitFor();
    assert.equal(
      await page.locator("html").evaluate((el) => el.classList.contains("theme-transitioning")),
      false,
    );
    const transition = await page.evaluate(async () => {
      const html = document.documentElement;
      const surface = document.querySelector(".ds-root")!;
      const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]')!;
      const initialColor = getComputedStyle(surface).backgroundColor;
      button.click();
      const style = getComputedStyle(surface);
      const duration = style.transitionDuration;
      const easing = style.transitionTimingFunction;
      const guarded = html.classList.contains("theme-transitioning");
      const fade = surface
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "background-color",
        );
      if (!fade) throw new Error("Expected a background-color CSS transition");
      fade.pause();
      fade.currentTime = 90;
      const middle = getComputedStyle(surface).backgroundColor;
      fade.play();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        before: initialColor,
        middle,
        after: getComputedStyle(surface).backgroundColor,
        duration,
        easing,
        guarded,
        cleaned: !html.classList.contains("theme-transitioning"),
      };
    });
    assert.equal(transition.guarded, true);
    assert.ok(transition.duration.split(", ").every((value) => value === "0.18s"));
    assert.ok(transition.easing.split(", ").every((value) => value === "ease-in-out"));
    assert.notEqual(transition.middle, transition.before);
    assert.notEqual(transition.middle, transition.after);
    assert.equal(transition.cleaned, true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]')!.click();
      return {
        guarded: document.documentElement.classList.contains("theme-transitioning"),
        color: getComputedStyle(document.querySelector(".ds-root")!).backgroundColor,
      };
    });
    assert.equal(reduced.guarded, false);
    assert.equal(reduced.color, transition.before);
  } finally {
    await page.close();
  }
});

test("theme icons inherit one color transition without flashing", async () => {
  const page = await getBrowser().newPage({ colorScheme: "dark", reducedMotion: "no-preference" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    await page.locator("#theme").hover();
    const result = await page.evaluate(async () => {
      const button = document.querySelector<HTMLButtonElement>("#theme")!;
      const mismatches: { theme: string | undefined; color: string; stroke: string }[] = [];
      let frames = 0;
      // System-dark -> Light -> Dark covers both color directions and class cleanup.
      for (let toggle = 0; toggle < 2; toggle++) {
        button.click();
        const start = performance.now();
        while (performance.now() - start < 650) {
          // oxlint-disable-next-line no-await-in-loop
          await new Promise(requestAnimationFrame);
          frames++;
          const color = getComputedStyle(button).color;
          for (const svg of button.querySelectorAll<SVGElement>(
            "[data-theme-icon]:not([hidden]) svg",
          )) {
            const stroke = getComputedStyle(svg).stroke;
            if (stroke !== color)
              mismatches.push({ theme: document.documentElement.dataset.theme, color, stroke });
          }
        }
      }
      return { frames, mismatches };
    });
    assert.ok(result.frames > 2, "Capture intermediate color-transition frames");
    assert.deepEqual(
      result.mismatches,
      [],
      "Icon strokes must follow the button color on every frame",
    );
  } finally {
    await page.close();
  }
});

for (const iconName of ["upload", "error"] as const) {
  test(`${iconName} icon inherits its semantic color without a theme flash`, async () => {
    const page = await getBrowser().newPage({
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    try {
      await page.addInitScript(() => localStorage.setItem("lukis:theme:v1", "light"));
      await page.goto(baseUrl);
      await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
      if (iconName === "error") {
        await page.locator("#image-input").setInputFiles({
          name: "invalid.png",
          mimeType: "image/png",
          buffer: Buffer.from("invalid"),
        });
      }
      await page.waitForFunction((name) => {
        const icon = document.querySelector<HTMLElement>(`[data-message-icon="${name}"]`)!;
        return !icon.hidden && getComputedStyle(icon).opacity === "1";
      }, iconName);
      const result = await page.evaluate(async (name) => {
        const icon = document.querySelector<HTMLElement>(`[data-message-icon="${name}"]`)!;
        const svg = icon.querySelector("svg")!;
        const owner = name === "error" ? icon : icon.parentElement!;
        const mismatches: { color: string; stroke: string }[] = [];
        let frames = 0;
        for (let toggle = 0; toggle < 2; toggle++) {
          document.querySelector<HTMLButtonElement>("#theme")!.click();
          const start = performance.now();
          while (performance.now() - start < 650) {
            // oxlint-disable-next-line no-await-in-loop
            await new Promise(requestAnimationFrame);
            frames++;
            const color = getComputedStyle(owner).color;
            const stroke = getComputedStyle(svg).stroke;
            if (stroke !== color) mismatches.push({ color, stroke });
          }
        }
        const probe = document.createElement("span");
        probe.style.color = name === "error" ? "var(--destructive)" : "var(--muted-foreground)";
        document.body.append(probe);
        const expectedColor = getComputedStyle(probe).color;
        probe.remove();
        return { frames, mismatches, expectedColor, finalColor: getComputedStyle(svg).stroke };
      }, iconName);
      assert.ok(result.frames > 2, "Capture intermediate frames in both theme directions");
      assert.deepEqual(
        result.mismatches,
        [],
        "The icon must inherit its owner's color on every frame",
      );
      assert.equal(result.finalColor, result.expectedColor, "Preserve the icon's semantic color");
    } finally {
      await page.close();
    }
  });
}

test("theme control works without storage and honors reduced motion", async () => {
  const context = await getBrowser().newContext({ colorScheme: "light", reducedMotion: "reduce" });
  await context.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage unavailable");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const control = page.getByRole("button", { name: /^Theme:/ });
    await control.click();
    await control.click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    const icons = await control.locator("[data-theme-icon]").evaluateAll((elements) =>
      elements.map((element) => ({
        transform: getComputedStyle(element).transform,
        filter: getComputedStyle(element).filter,
      })),
    );
    assert.ok(icons.length > 0);
    assert.ok(
      icons.every(
        ({ transform, filter }) =>
          (transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)") &&
          filter === "blur(0px)",
      ),
    );
  } finally {
    await context.close();
  }
});

test("motion parity: error recovery preserves outgoing text and upload icons", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "no-preference" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const result = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File(["invalid"], "invalid.txt", { type: "text/plain" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      let sawError = false;
      let enteringTextOverlap = false;
      let recoveringTextOverlap = false;
      let enteringIconOverlap = false;
      let recoveringIconOverlap = false;
      // Keep this helper inside the function serialized into the browser.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const visible = (node: Element | undefined | null) =>
        !!node &&
        getComputedStyle(node).display !== "none" &&
        Number(getComputedStyle(node).opacity) > 0.01;
      const started = performance.now();
      while (performance.now() - started < 7_000) {
        // Sampling successive rendered frames must remain sequential.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
        const error =
          document.querySelector(".message-chrome")?.getAttribute("data-error") === "true";
        sawError ||= error;
        const texts = Array.from(document.querySelectorAll("[data-message-text]"));
        const normal = texts.find((node) => node.textContent === "Turn an image into a painting");
        const failure = texts.find(
          (node) => node.textContent === "Choose a PNG, JPEG, or WebP image.",
        );
        const textOverlap = visible(normal) && visible(failure);
        const iconOverlap =
          visible(document.querySelector('[data-message-icon="upload"]')) &&
          visible(document.querySelector('[data-message-icon="error"]'));
        if (error) {
          enteringTextOverlap ||= textOverlap;
          enteringIconOverlap ||= iconOverlap;
        } else if (sawError) {
          recoveringTextOverlap ||= textOverlap;
          recoveringIconOverlap ||= iconOverlap;
          if (texts.length === 1 && normal && Number(getComputedStyle(normal).opacity) >= 0.999)
            break;
        }
      }
      return {
        sawError,
        enteringTextOverlap,
        recoveringTextOverlap,
        enteringIconOverlap,
        recoveringIconOverlap,
      };
    });
    assert.deepEqual(result, {
      sawError: true,
      enteringTextOverlap: true,
      recoveringTextOverlap: true,
      enteringIconOverlap: true,
      recoveringIconOverlap: true,
    });
    await assertUploadStateRestored(page);
    assert.equal(await page.locator('[data-message-icon="error"]').isVisible(), false);
  } finally {
    await page.close();
  }
});

test("motion parity: theme icons overlap and settle after rapid reversal", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "no-preference" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const result = await page.evaluate(async () => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]')!;
      const icons = Array.from(button.querySelectorAll<HTMLElement>("[data-theme-icon]"));
      const shown = () =>
        icons.filter((icon) => !icon.hidden && Number(getComputedStyle(icon).opacity) > 0.01);
      button.click();
      let overlap = false;
      const started = performance.now();
      while (performance.now() - started < 700) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
        if (shown().length > 1) {
          overlap = true;
          break;
        }
      }
      // Reverse the first icon's exit before it completes, then let all callbacks settle.
      button.click();
      button.click();
      const reversed = performance.now();
      while (performance.now() - reversed < 700) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
      }
      return {
        overlap,
        theme: document.documentElement.dataset.theme,
        shown: shown().map((icon) => icon.dataset.themeIcon),
      };
    });
    assert.deepEqual(result, { overlap: true, theme: "system", shown: ["system"] });
  } finally {
    await page.close();
  }
});

function intermediateMonochrome(frame: { opacity: number; grayscale: number }): boolean {
  return (
    frame.opacity > 0.17 && frame.opacity < 0.99 && frame.grayscale > 0.01 && frame.grayscale < 0.99
  );
}

test("motion parity: replacement monochrome interpolates and reverses continuously", async () => {
  const page = await getBrowser().newPage({ colorScheme: "light", reducedMotion: "no-preference" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "motion.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 320, 240),
    });
    await waitForProcessedImage(page, { width: 320, height: 240 });
    const result = await page.evaluate(async () => {
      const dropzone = document.querySelector<HTMLElement>(".dropzone")!;
      const canvas = document.querySelector<HTMLCanvasElement>("#preview")!;
      const sample = () => {
        const style = getComputedStyle(canvas);
        return {
          opacity: Number(style.opacity),
          grayscale: Number(style.filter.match(/grayscale\(([^)]+)\)/)?.[1]),
          mask: style.maskImage,
        };
      };
      const initial = sample();
      const entering: ReturnType<typeof sample>[] = [];
      dropzone.dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
      const started = performance.now();
      while (performance.now() - started < 900) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
        entering.push(sample());
      }
      const monochrome = sample();
      const leaving: ReturnType<typeof sample>[] = [];
      dropzone.dispatchEvent(new Event("dragleave", { bubbles: true }));
      const reversed = performance.now();
      while (performance.now() - reversed < 900) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
        leaving.push(sample());
      }
      const restored = sample();
      dropzone.dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
      const interruptedAt = performance.now();
      let beforeReversal = sample();
      while (performance.now() - interruptedAt < 600) {
        // Reverse on an observed intermediate frame, not a fixed wall-clock delay.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
        beforeReversal = sample();
        if (beforeReversal.opacity > 0.3 && beforeReversal.opacity < 0.9) break;
      }
      dropzone.dispatchEvent(new Event("dragleave", { bubbles: true }));
      const afterReversal = sample();
      const interruptedExit: ReturnType<typeof sample>[] = [];
      const resumedAt = performance.now();
      while (performance.now() - resumedAt < 900) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise(requestAnimationFrame);
        interruptedExit.push(sample());
      }
      return {
        initial,
        entering,
        monochrome,
        leaving,
        restored,
        beforeReversal,
        afterReversal,
        interruptedExit,
        settled: sample(),
      };
    });
    assert.ok(
      result.entering.some(intermediateMonochrome),
      "Hover must interpolate opacity and grayscale.",
    );
    assert.ok(
      result.leaving.some(intermediateMonochrome),
      "Hover exit must interpolate from its current appearance.",
    );
    assert.ok(
      result.entering.some(
        (frame) => frame.mask !== result.initial.mask && frame.mask !== result.monochrome.mask,
      ),
      "The mask must interpolate with the image.",
    );
    assert.ok(Math.abs(result.monochrome.opacity - 0.16) < 0.001);
    assert.equal(result.restored.opacity, 1);
    assert.equal(result.restored.grayscale, 0);
    assert.ok(
      intermediateMonochrome(result.beforeReversal),
      "Reverse while the hover is still moving.",
    );
    assert.ok(
      Math.abs(result.afterReversal.opacity - result.beforeReversal.opacity) < 0.005,
      "Reversal must preserve the current opacity.",
    );
    assert.ok(
      Math.abs(result.afterReversal.grayscale - result.beforeReversal.grayscale) < 0.005,
      "Reversal must preserve the current grayscale.",
    );
    assert.equal(
      result.afterReversal.mask,
      result.beforeReversal.mask,
      "Reversal must preserve the current mask.",
    );
    assert.ok(
      result.interruptedExit.some(intermediateMonochrome),
      "Interrupted hover must animate back to color.",
    );
    assert.equal(result.settled.opacity, 1);
    assert.equal(result.settled.grayscale, 0);
  } finally {
    await page.close();
  }
});

test("motion parity: reduced motion retains preview fade without slider stretch", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.evaluate(() => {
      const state = { samples: [] as number[], done: false };
      (window as Window & { reducedReveal?: typeof state }).reducedReveal = state;
      const clip = document.querySelector<HTMLElement>(".canvas-clip")!;
      const started = performance.now();
      function sample() {
        if (clip.getAttribute("aria-hidden") === "false") {
          const opacity = Number(getComputedStyle(clip).opacity);
          state.samples.push(opacity);
          if (opacity >= 0.999) state.done = true;
        }
        if (!state.done && performance.now() - started < 10_000) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "reduced.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 320, 240),
    });
    await waitForProcessedImage(page, { width: 320, height: 240 });
    const samples = await page.evaluate(
      () => (window as Window & { reducedReveal?: { samples: number[] } }).reducedReveal!.samples,
    );
    const slider = page.getByRole("slider", { name: "Paint", exact: true });
    const bounds = (await slider.boundingBox())!;
    const initialWidth = await slider
      .locator(".slider-track")
      .evaluate((node) => node.getBoundingClientRect().width);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 200, bounds.y + bounds.height / 2, { steps: 5 });
    const held = await slider
      .locator(".slider-track")
      .evaluate((node) => node.getBoundingClientRect().width);
    await page.mouse.up();
    assert.ok(
      samples.some((opacity) => opacity > 0 && opacity < 0.999),
      `Reduced preview must fade: ${JSON.stringify(samples)}`,
    );
    assert.ok(
      Math.abs(held - initialWidth) < 0.5,
      `Reduced motion stretched the slider by ${held - initialWidth}px.`,
    );
  } finally {
    await page.close();
  }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`export feedback keeps busy icons and swaps to success checks (${reducedMotion})`, async () => {
    const page = await getBrowser().newPage({
      reducedMotion,
      viewport: { width: 320, height: 720 },
    });
    const issues = watchForBrowserErrors(page);
    try {
      await page.goto(baseUrl);
      await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
      await page.locator('input[type="file"]').setInputFiles({
        name: "export.png",
        mimeType: "image/png",
        buffer: await createSplitColorPng(page, 64, 48),
      });
      await waitForProcessedImage(page, { width: 64, height: 48 });
      await page.evaluate(() => {
        const toBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          setTimeout(() => toBlob.call(this, callback, type, quality), 450);
        };
        // Capture the real PNG using native ClipboardItem, without changing the OS clipboard.
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            async write(items: ClipboardItem[]) {
              document.body.dataset.copyCalls = String(
                Number(document.body.dataset.copyCalls ?? 0) + 1,
              );
              const blob = await items[0].getType("image/png");
              const reader = new FileReader();
              const encoded = new Promise<string>((resolve) => {
                reader.addEventListener("load", () => resolve(String(reader.result)), {
                  once: true,
                });
                reader.readAsDataURL(blob);
              });
              document.body.dataset.copiedPng = await encoded;
            },
          },
        });
      });
      const downloaded = page.waitForEvent("download");
      await page.locator("#download").click();
      await page.waitForFunction(
        () => document.querySelector("#download")?.getAttribute("aria-busy") === "true",
      );
      assert.equal(await page.locator("#copy").isDisabled(), true);
      assert.equal(await page.locator("#download [data-button-icon='idle']").isVisible(), true);
      assert.equal(await page.locator("#download .spinner").count(), 0);
      const download = await downloaded;
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const png = `data:image/png;base64,${Buffer.concat(chunks).toString("base64")}`;
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>("#download")?.dataset.feedbackState === "success",
      );
      const drawn = await page.evaluate(async () => {
        const path = document.querySelector("#download [data-animated-check]")!;
        const offsets: number[] = [];
        const start = performance.now();
        while (performance.now() - start < 500) {
          offsets.push(Number.parseFloat(getComputedStyle(path).strokeDashoffset));
          // oxlint-disable-next-line no-await-in-loop
          await new Promise(requestAnimationFrame);
        }
        return offsets;
      });
      assert.equal(drawn.at(-1), 0);
      if (reducedMotion === "reduce") assert.ok(drawn.every((offset) => offset === 0));
      else
        assert.ok(
          drawn.some((offset) => offset > 0 && offset < 1),
          "The check must draw, not pop in.",
        );
      await page.locator("#download").hover();
      assert.equal(
        await page
          .locator("#download [data-animated-check]")
          .evaluate((path) => getComputedStyle(path).strokeDashoffset),
        "0px",
      );
      await page.locator("#copy").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector("#copy")?.getAttribute("aria-busy") === "true",
      );
      await page.evaluate(() => document.querySelector<HTMLButtonElement>("#copy")!.click());
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>("#copy")?.dataset.feedbackState === "success",
      );
      assert.equal(await page.locator("body").getAttribute("data-copy-calls"), "1");
      assert.equal(await page.locator("body").getAttribute("data-copied-png"), png);
      assert.equal(
        await page.locator(".status").textContent(),
        "Painterly PNG copied to clipboard.",
      );
      const layout = await page.locator(".control-actions").evaluate((row) => ({
        width: row.getBoundingClientRect().width,
        scroll: row.scrollWidth,
        exportGap:
          row.querySelector("#copy")!.getBoundingClientRect().left -
          row.querySelector("#download")!.getBoundingClientRect().right,
        rightGap:
          row.getBoundingClientRect().right -
          row.querySelector("#copy")!.getBoundingClientRect().right,
      }));
      assert.ok(layout.scroll <= layout.width + 1, "Three buttons must fit on mobile.");
      assert.equal(layout.exportGap, 8);
      assert.ok(Math.abs(layout.rightGap) < 1, "Export actions stay grouped on the right.");
      await page.waitForFunction(
        () => document.querySelector<HTMLElement>("#copy")?.dataset.feedbackState === "idle",
      );
      assertNoBrowserErrors(issues);
    } finally {
      await page.close();
    }
  });
}

test("export failures restore the idle icon and preserve the downloadable image", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "reduce" });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "failure.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 64, 48),
    });
    await waitForProcessedImage(page, { width: 64, height: 48 });
    const baselinePng = await downloadPixels(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          write() {
            return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
          },
        },
      });
    });
    await page.locator("#copy").click();
    await page.waitForFunction(() =>
      document.querySelector(".status")?.textContent?.includes("could not be copied"),
    );
    assert.equal(await page.locator("#copy").getAttribute("data-feedback-state"), "idle");
    assert.equal(await page.locator("#copy").getAttribute("aria-busy"), null);
    assert.equal(await page.locator("#download").isEnabled(), true);
    assert.equal(await downloadPixels(page), baselinePng);
    await page.evaluate(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        HTMLCanvasElement.prototype.toBlob = toBlob;
        callback(null);
      };
    });
    await page.locator("#download").click();
    await page.waitForFunction(() =>
      document.querySelector(".status")?.textContent?.includes("could not be downloaded"),
    );
    assert.equal(await page.locator("#download").getAttribute("data-feedback-state"), "idle");
    assert.equal(await downloadPixels(page), baselinePng);
  } finally {
    await page.close();
  }
});

test("unavailable image clipboard disables Copy but preserves Download", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "reduce" });
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    await page.locator('input[type="file"]').setInputFiles({
      name: "unsupported.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 64, 48),
    });
    await waitForProcessedImage(page, { width: 64, height: 48 });
    assert.equal(await page.locator("#copy").isDisabled(), true);
    assert.equal(await page.locator("#download").isEnabled(), true);
    assert.match((await page.locator("#copy").getAttribute("title")) ?? "", /unavailable/);
  } finally {
    await page.close();
  }
});

for (const unavailable of ["missing", "rejected", "pipeline failure", "surface failure"] as const) {
  test(`uses WebGL2 seamlessly when WebGPU is ${unavailable}`, async () => {
    const page = await getBrowser().newPage({ reducedMotion: "reduce" });
    const issues = watchForBrowserErrors(page);
    try {
      await page.addInitScript((mode) => {
        if (mode === "surface failure") {
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (
            this: HTMLCanvasElement,
            type: string,
            ...args: unknown[]
          ) {
            if (type === "webgpu") return null;
            return Reflect.apply(getContext, this, [type, ...args]);
          } as typeof getContext;
          return;
        }
        if (mode === "pipeline failure") {
          GPUDevice.prototype.createRenderPipeline = () => {
            throw new Error("Pipeline unavailable");
          };
          return;
        }
        Object.defineProperty(navigator, "gpu", {
          configurable: true,
          value:
            mode === "missing"
              ? undefined
              : {
                  requestAdapter: () => Promise.reject(new Error("Adapter unavailable")),
                },
        });
      }, unavailable);
      await page.goto(baseUrl);
      await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
      assert.equal(await page.locator('input[type="file"]').isEnabled(), true);
      await page.locator('input[type="file"]').setInputFiles({
        name: "fallback.png",
        mimeType: "image/png",
        buffer: await createSplitColorPng(page, 96, 64),
      });
      await waitForProcessedImage(page, { width: 96, height: 64 });
      assert.equal(
        await page.evaluate(() => !!document.querySelector("canvas")!.getContext("webgl2")),
        true,
      );
      await assertImageGeometry(page, { width: 96, height: 64 });
      if (unavailable === "missing" && process.env.LUKIS_TEST_SCREENSHOT) {
        await page.screenshot({ path: process.env.LUKIS_TEST_SCREENSHOT });
      }
      assert.ok(await downloadPixels(page));
      assertNoBrowserErrors(issues);
    } finally {
      await page.close();
    }
  });
}

test("WebGL2 allocation failure preserves the previous image and export", async () => {
  const page = await getBrowser().newPage({ reducedMotion: "reduce" });
  const issues = watchForBrowserErrors(page);
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    });
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    const input = {
      name: "valid.png",
      mimeType: "image/png",
      buffer: await createSplitColorPng(page, 96, 64),
    };
    await page.locator('input[type="file"]').setInputFiles(input);
    await waitForProcessedImage(page, { width: 96, height: 64 });
    const baseline = await downloadPixels(page);
    await page.evaluate(() => {
      const allocate = WebGL2RenderingContext.prototype.texStorage2D;
      WebGL2RenderingContext.prototype.texStorage2D = function () {
        WebGL2RenderingContext.prototype.texStorage2D = allocate;
        throw new Error("Injected texture allocation failure");
      };
    });
    await page.locator('input[type="file"]').setInputFiles({ ...input, name: "replacement.png" });
    await page.waitForFunction(() =>
      document.querySelector(".status")?.textContent?.includes("That image could not be processed"),
    );
    assert.equal(await downloadPixels(page), baseline);
    await page.locator('input[type="file"]').setInputFiles(input);
    await waitForProcessedImage(page, { width: 96, height: 64 });
    assert.equal(await downloadPixels(page), baseline);
    assert.equal(issues.consoleErrors.length, 1);
    assert.match(issues.consoleErrors[0], /Injected texture allocation failure/);
    issues.consoleErrors.length = 0;
    assertNoBrowserErrors(issues);
  } finally {
    await page.close();
  }
});

test("keeps the upload icon still while the empty dropzone expands and contracts", async () => {
  const page = await getBrowser().newPage({
    viewport: { width: 1280, height: 960 },
    reducedMotion: "no-preference",
  });
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.documentElement.dataset.processorState === "ready");
    const restingBounds = await page.locator(".dropzone").boundingBox();
    assert.ok(restingBounds);
    await page.evaluate(() => {
      const samples: {
        x: number;
        y: number;
        width: number;
        height: number;
        boundsWidth: number;
      }[] = [];
      (window as typeof window & { hoverIconSamples: typeof samples }).hoverIconSamples = samples;
      const start = performance.now();
      function sample() {
        const icon = document
          .querySelector('[data-message-icon="upload"] svg')!
          .getBoundingClientRect();
        samples.push({
          x: icon.x,
          y: icon.y,
          width: icon.width,
          height: icon.height,
          boundsWidth: document.querySelector(".dropzone")!.getBoundingClientRect().width,
        });
        if (performance.now() - start < 1600) requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    await page.locator(".dropzone").hover();
    await page.waitForTimeout(700);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(950);
    const returnedBounds = await page.locator(".dropzone").boundingBox();
    assert.ok(returnedBounds);
    assert.ok(
      Math.abs(returnedBounds.width - restingBounds.width) < 0.001,
      "Mouse leave must restore the resting dropzone width",
    );
    const samples = await page.evaluate(
      () =>
        (
          window as typeof window & {
            hoverIconSamples: {
              x: number;
              y: number;
              width: number;
              height: number;
              boundsWidth: number;
            }[];
          }
        ).hoverIconSamples,
    );
    assert.ok(samples.length > 20, "Capture intermediate expansion and contraction frames");
    const spread = (key: keyof (typeof samples)[number]) =>
      Math.max(...samples.map((s) => s[key])) - Math.min(...samples.map((s) => s[key]));
    assert.ok(spread("boundsWidth") > 15, "The dropzone must still expand");
    for (const key of ["x", "y", "width", "height"] as const) {
      assert.ok(spread(key) < 0.001, `Upload icon ${key} drifted by ${spread(key)}px`);
    }
  } finally {
    await page.close();
  }
});

test("disables upload only when both graphics APIs are unavailable", async () => {
  const context = await getBrowser().newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type === "webgl2") return null;
      return Reflect.apply(getContext, this, [type, ...args]);
    } as typeof getContext;
  });
  const page = await context.newPage();
  const issues = watchForBrowserErrors(page);

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!document.documentElement.dataset.processorState);
    const dropzone = page.getByRole("button", {
      name: "Turn an image into a painting",
    });
    await dropzone.waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Turn an image into a painting"]')
          ?.disabled === true,
    );

    assert.equal(await dropzone.isEnabled(), false);
    await assertErrorChrome(
      page,
      "Lukis needs WebGPU or WebGL 2. Open it in a browser with graphics acceleration enabled on a supported device.",
    );
    await page.waitForTimeout(5_100);
    await assertErrorChrome(
      page,
      "Lukis needs WebGPU or WebGL 2. Open it in a browser with graphics acceleration enabled on a supported device.",
    );
    assertNoBrowserErrors(issues);
  } finally {
    await context.close();
  }
});
