/* oxlint-disable no-await-in-loop -- GPU state and paired exports must be tested in order. */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { dev } from "astro";
import { DEFAULT_RIPPLE, type RippleSettings, type RippleMotion } from "../src/lib/processor.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const renderer = process.env.LUKIS_TEST_RENDERER ?? "webgpu";
const webgl = renderer.startsWith("webgl2");
const workspace = await realpath(await mkdtemp(join(tmpdir(), "lukis-gpu-")));
const directory = join(workspace, "results");
let server: Awaited<ReturnType<typeof dev>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all(
    [
      "src",
      "public",
      "test/fixtures/buttons/src",
      "test/fixtures/buttons/astro.config.mjs",
      "test/fixtures/buttons/tsconfig.json",
      "test/fixtures/painterly-reference.ts",
      "package.json",
      "tsconfig.json",
    ].map((entry) => cp(join(root, entry), join(workspace, entry), { recursive: true })),
  );
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  await mkdir(directory);
  server = await dev({
    root: join(workspace, "test/fixtures/buttons"),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  // Pixel comparisons need exact readback. This flag affects this disposable test browser only.
  browser = await chromium.launch({
    executablePath: "/Applications/Helium.app/Contents/MacOS/Helium",
    headless: true,
    args: ["--disable-features=HeliumNoiseCanvas"],
  });
  const page = await browser.newPage();
  await page.addInitScript((mode) => {
    if (mode.startsWith("webgl2")) {
      Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      if (mode === "webgl2-rgba8") {
        const getExtension = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function (name) {
          return name === "EXT_color_buffer_float"
            ? null
            : Reflect.apply(getExtension, this, [name]);
        };
      }
      return;
    }
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (options) {
      const device = await request.call(this, options);
      Object.defineProperty(window, "testDevice", { value: device, configurable: true });
      return device;
    };
  }, renderer);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address.port}/gpu`);
  await page.getByRole("status").filter({ hasText: "Initialized" }).waitFor();
  const input = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 800, 600);
    gradient.addColorStop(0, "#f04c78");
    gradient.addColorStop(0.5, "#72b8ca");
    gradient.addColorStop(1, "#223548");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 800, 600);
    context.fillStyle = "#eedb85";
    context.fillRect(75, 80, 225, 320);
    context.fillStyle = "#3b678a";
    context.beginPath();
    context.arc(510, 300, 160, 0, Math.PI * 2);
    context.fill();
    return canvas.toDataURL();
  });
  const start = performance.now();
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(input.split(",")[1], "base64"),
  });
  await page.getByRole("status").filter({ hasText: "Ready: 1" }).waitFor();
  assert.equal(
    await page.evaluate((mode) => {
      const canvas = document.querySelector("canvas")!;
      return !!canvas.getContext(mode.startsWith("webgl2") ? "webgl2" : "webgpu");
    }, renderer),
    true,
    "The requested renderer must actually process the image",
  );
  const uploadMs = performance.now() - start;
  const exportStart = performance.now();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PNG" }).click(),
  ]);
  await download.saveAs(`${directory}/output.png`);
  const exportMs = performance.now() - exportStart;
  async function comparePaths(paths: string[]) {
    const images = await Promise.all(
      paths.map(async (path) => (await readFile(path)).toString("base64")),
    );
    return page.evaluate(async (encodedImages) => {
      const decoded = await Promise.all(
        encodedImages.map(async (base64) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return {
            width: image.width,
            height: image.height,
            data: context.getImageData(0, 0, image.width, image.height).data,
          };
        }),
      );
      let total = 0,
        max = 0,
        over2 = 0;
      const [a, b] = decoded;
      for (let i = 0; i < a.data.length; i++) {
        if (i % 4 === 3) continue;
        const delta = Math.abs(a.data[i] - b.data[i]);
        total += delta;
        max = Math.max(max, delta);
        if (delta > 2) over2++;
      }
      return {
        dimensions: decoded.map(({ width, height }) => ({ width, height })),
        meanAbsoluteError: total / (a.width * a.height * 3),
        max,
        fractionOver2: over2 / (a.width * a.height * 3),
      };
    }, images);
  }
  async function savePair(name: string) {
    const images = await page.evaluate(() =>
      (
        window as typeof window & {
          exportTestPngs(): Promise<{ output: string; reference: string }>;
        }
      ).exportTestPngs(),
    );
    await Promise.all([
      writeFile(`${directory}/${name}-gpu.png`, Buffer.from(images.output.split(",")[1], "base64")),
      writeFile(
        `${directory}/${name}-gl.png`,
        Buffer.from(images.reference.split(",")[1], "base64"),
      ),
    ]);
    return comparePaths([`${directory}/${name}-gl.png`, `${directory}/${name}-gpu.png`]);
  }
  const comparison = await savePair("initial");
  const downloaded = await comparePaths([
    `${directory}/initial-gpu.png`,
    `${directory}/output.png`,
  ]);
  assert.deepEqual(
    downloaded.dimensions,
    comparison.dimensions,
    "The real download must preserve export dimensions",
  );
  assert.equal(downloaded.max, 0, "The real download must match the PNG export");
  const rippleFrames = [];
  const transparentBackdrop = await page.addStyleTag({
    content: "html, body, canvas { background: transparent !important; }",
  });
  const presentationCases: Array<[number, number, RippleSettings?, RippleMotion?]> = [
    [1, 1],
    [0, 0],
    [0.02, 0.08],
    [0.3, 0.1],
    [0.5, 0.15],
    [1, 0.65],
    [1, 0.85],
    [1, 1],
    [1, 0.35, { ...DEFAULT_RIPPLE, height: 0 }],
    [1, 0.35, { ...DEFAULT_RIPPLE, strength: 0 }],
    [1, 0.35, { ...DEFAULT_RIPPLE, width: 0.3 }],
    [1, 0.35, { ...DEFAULT_RIPPLE, width: 0.3, count: 3, spacing: 0.25 }],
    [1, 0.35, { ...DEFAULT_RIPPLE, width: 0.3, count: 3, echo: 0 }],
    [1, 1, DEFAULT_RIPPLE, { distance: 0.7, amplitude: 0.5 }],
    [1, 1, DEFAULT_RIPPLE, { distance: 0.7, amplitude: 0 }],
    [1, 0.35, { ...DEFAULT_RIPPLE, width: 0.3, blurPx: 16 }],
    [1, 0.35, { ...DEFAULT_RIPPLE, strength: 0, blurPx: 16 }],
    [1, 1, DEFAULT_RIPPLE, { distance: 0.7, amplitude: -0.5 }],
  ];
  for (const [progress, wave, settings, motion] of presentationCases) {
    const passes = await page.evaluate(
      async (value) => {
        const fixture = window as typeof window & {
          presentTestFrame(
            progress: number,
            wave: number,
            settings?: RippleSettings,
            motion?: RippleMotion,
          ): Promise<number>;
          exportTestPngs(): Promise<{ output: string }>;
        };
        const before = (await fixture.exportTestPngs()).output;
        const count = await fixture.presentTestFrame(
          value.progress,
          value.wave,
          value.settings,
          value.motion,
        );
        if ((await fixture.exportTestPngs()).output !== before)
          throw new Error("Ripple changed the PNG export");
        return count;
      },
      { progress, wave, settings, motion },
    );
    // Capture the composited canvas; GPU canvas backing stores are transient.
    const image = await page.locator("canvas").first().screenshot({ omitBackground: true });
    rippleFrames.push({ image: image.toString("base64"), passes, progress, wave });
  }
  await transparentBackdrop.evaluate((element) => element.parentNode?.removeChild(element));
  const ripple = await page.evaluate(async (encodedFrames) => {
    const frames: Array<(typeof encodedFrames)[number] & { pixels: Uint8ClampedArray }> = [];
    for (const frame of encodedFrames) {
      const image = new Image();
      image.src = `data:image/png;base64,${frame.image}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      frames.push({
        ...frame,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      });
    }
    const first = frames[0].pixels;
    return frames.map(({ pixels, passes, progress }, index) => {
      let changed = 0;
      let visible = 0;
      let opaque = 0;
      let featherPixels = 0;
      let visibleWarped = 0;
      let trailingWarped = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const x = (i / 4) % 800;
        const y = Math.floor(i / 4 / 800);
        const delta = Math.max(
          ...[0, 1, 2].map((channel) => Math.abs(pixels[i + channel] - first[i + channel])),
        );
        if (delta > 2) changed++;
        const alpha = pixels[i + 3];
        if (alpha > 0) visible++;
        if (alpha === 255) opaque++;
        // PNG RGB is unpremultiplied; alpha alone must not satisfy this check.
        if (alpha >= 128 && delta > 8) visibleWarped++;
        if (alpha === 255 && delta > 3) trailingWarped++;
        if (y === 300 && alpha > 16 && alpha < 239) featherPixels++;
        if (index > 1 && alpha < frames[index - 1].pixels[i + 3])
          throw new Error("The reveal mask must only expand");
        // Each horizontal and vertical ray has one edge, with no trailing holes.
        if (index > 1 && (y === 300 || x === 400)) {
          const inner = y === 300 ? i + (x < 400 ? 4 : -4) : i + (y < 300 ? 3200 : -3200);
          if (inner >= 0 && inner < pixels.length && alpha > pixels[inner + 3])
            throw new Error("The mask must reveal one continuous circle");
        }
      }
      return {
        index,
        changed,
        progress,
        visible,
        opaque,
        featherPixels,
        visibleWarped,
        trailingWarped,
        passes,
        exact: pixels.every((value, i) => value === first[i]),
      };
    });
  }, rippleFrames);
  for (const frame of ripple) {
    assert.equal(frame.passes, 1, "Ripple must reuse the cached painting");
  }
  assert.equal(ripple[1].visible, 0, "The first frame must be fully masked");
  assert.ok(ripple[2].visible > 0, "The wave must reveal pixels immediately after starting");
  assert.ok(
    ripple[3].visible > ripple[2].visible && ripple[4].visible > ripple[3].visible,
    "One reveal front must expand across the image",
  );
  for (const frame of ripple.slice(5))
    assert.equal(frame.opaque, 800 * 600, "The settling wave must keep the image opaque");
  assert.ok(ripple[4].featherPixels > 200, "The reveal must have a broad gradient edge");
  assert.ok(ripple[3].visibleWarped > 1000, "The bend must be visible early in the reveal");
  assert.ok(ripple[4].visibleWarped > 1000, "The broad wave must visibly bend and light the image");
  assert.ok(ripple[5].trailingWarped > 1000, "The wave must continue after the mask completes");
  assert.ok(ripple[6].changed < ripple[5].changed, "The remaining deformation must recede");
  assert.ok(ripple[7].exact, "The ripple must settle to the exact original display pixels");
  assert.ok(
    ripple[8].exact,
    "Live height zero must remove the bend without changing filter passes or export",
  );
  console.log({ renderer, ripple });
  assert.ok(ripple[9].exact, "Overall strength zero disables distortion and lighting");
  assert.ok(ripple[11].changed > ripple[10].changed, "Multiple waves affect more of the image");
  assert.equal(
    rippleFrames[12].image,
    rippleFrames[10].image,
    "Echo zero leaves only the first wave",
  );
  assert.ok(
    ripple[13].changed > 1000,
    "Custom motion can keep a bend after the legacy clock completes",
  );
  assert.ok(ripple[14].exact, "Custom motion completion restores exact flat pixels");
  assert.notEqual(
    rippleFrames[15].image,
    rippleFrames[10].image,
    "Localized blur changes the wave",
  );
  assert.ok(ripple[16].exact, "Strength zero also removes localized blur");
  assert.ok(
    ripple[17].changed > 1000,
    "Explicit signed deformation must survive the flat fast path",
  );
  const originBackdrop = await page.addStyleTag({
    content: "html, body, canvas { background: transparent !important; }",
  });
  for (const [originX, originY] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const presentAt = (progress: number, amplitude: number) =>
      page.evaluate(
        async (value) => {
          const fixture = window as typeof window & {
            presentTestFrame(
              progress: number,
              wave: number,
              settings: RippleSettings,
              motion: RippleMotion,
            ): Promise<number>;
          };
          return fixture.presentTestFrame(value.progress, 1, value.settings, value.motion);
        },
        {
          progress,
          settings: DEFAULT_RIPPLE,
          motion: { distance: 0.7, amplitude, originX, originY },
        },
      );
    assert.equal(await presentAt(0.12, 0.5), 1);
    const masked = (
      await page.locator("canvas").first().screenshot({ omitBackground: true })
    ).toString("base64");
    const alpha = await page.evaluate(
      async ({ masked, originX, originY }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${masked}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const nearX = Math.round(originX * (canvas.width - 1));
        const nearY = Math.round(originY * (canvas.height - 1));
        return {
          near: context.getImageData(nearX, nearY, 1, 1).data[3],
          far: context.getImageData(canvas.width - 1 - nearX, canvas.height - 1 - nearY, 1, 1)
            .data[3],
        };
      },
      { masked, originX, originY },
    );
    assert.ok(
      alpha.near > 128 && alpha.far === 0,
      "The mask must start at the selected corner, with matching Y orientation in both renderers",
    );
    assert.equal(await presentAt(1, 0.5), 1);
    const bent = (
      await page.locator("canvas").first().screenshot({ omitBackground: true })
    ).toString("base64");
    assert.notEqual(bent, rippleFrames[13].image, "The wave must move with the mask origin");
    assert.equal(await presentAt(1, 0), 1);
    const settled = (
      await page.locator("canvas").first().screenshot({ omitBackground: true })
    ).toString("base64");
    assert.equal(
      settled,
      rippleFrames[0].image,
      "Every drop origin must settle to identical flat pixels",
    );
  }
  await originBackdrop.evaluate((element) => element.parentNode?.removeChild(element));
  const strengths = [];
  for (const value of [0, 1]) {
    await page.getByLabel("Paint").fill(String(value));
    await page.getByLabel("Paint").press("Tab");
    strengths.push({ value, comparison: await savePair(`strength-${value}`) });
    assert.equal(await page.getByRole("status").textContent(), "Ready: 1");
  }
  await page.getByLabel("Paint").fill("0.5");
  await page.getByLabel("Paint").press("Tab");
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("status").textContent(), "Ready: 1");
  await page.getByLabel("Brush").fill("2");
  await page.getByLabel("Brush").press("Tab");
  await page.getByRole("status").filter({ hasText: "Ready: 2" }).waitFor();
  const beforeInvalid = await savePair("before-invalid");
  await page.locator('input[type="file"]').setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await page.getByRole("status").filter({ hasText: "Error" }).waitFor();
  await savePair("after-invalid");
  const rollback = await comparePaths([
    `${directory}/before-invalid-gpu.png`,
    `${directory}/after-invalid-gpu.png`,
  ]);
  assert.equal(rollback.max, 0);
  await page
    .locator('input[type="file"]')
    .setInputFiles(join(workspace, "public/window-reference-painterly.png"));
  await page.getByRole("status").filter({ hasText: "Ready: 3" }).waitFor();
  const natural = await savePair("natural");
  const transparentFixture = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgba(240,32,64,.25)";
    context.fillRect(0, 0, 96, 32);
    context.fillStyle = "rgba(32,64,240,.7)";
    context.fillRect(0, 32, 96, 32);
    return canvas.toDataURL();
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "alpha.png",
    mimeType: "image/png",
    buffer: Buffer.from(transparentFixture.split(",")[1], "base64"),
  });
  await page.getByRole("status").filter({ hasText: "Ready: 4" }).waitFor();
  const transparent = await savePair("transparent");
  for (const sample of [
    comparison,
    natural,
    transparent,
    beforeInvalid,
    ...strengths.map((item) => item.comparison),
  ]) {
    // RGBA8 cache quantizes the filtered color before blending, by at most 1/255.
    const tolerance = renderer === "webgl2-rgba8" ? 0.3 : 0.1;
    assert.ok(
      sample.meanAbsoluteError < tolerance,
      `Average RGB error ${sample.meanAbsoluteError} must remain below ${tolerance} of 255`,
    );
    assert.ok(
      sample.fractionOver2 < 0.0001,
      "Large rounding differences must remain below 0.01% of channels",
    );
  }
  assert.deepEqual(comparison.dimensions, [
    { width: 800, height: 600 },
    { width: 800, height: 600 },
  ]);
  const fatalMessage = webgl
    ? "The graphics device was lost. Reload Lukis to continue."
    : "Injected GPU memory failure";
  await page.evaluate((useWebGl) => {
    if (useWebGl) {
      document
        .querySelector("canvas")!
        .getContext("webgl2")!
        .getExtension("WEBGL_lose_context")!
        .loseContext();
      return;
    }
    const device = (window as typeof window & { testDevice: GPUDevice }).testDevice;
    device.dispatchEvent(
      new GPUUncapturedErrorEvent("uncapturederror", {
        error: new GPUOutOfMemoryError("Injected GPU memory failure"),
      }),
    );
  }, webgl);
  await page.getByRole("status").filter({ hasText: fatalMessage }).waitFor();
  let unexpectedDownload = false;
  page.once("download", () => {
    unexpectedDownload = true;
  });
  await page.getByRole("button", { name: "Download PNG" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: `Error: ${fatalMessage}` })
    .waitFor();
  assert.equal(unexpectedDownload, false);
  assert.deepEqual(errors, []);
  const result = {
    renderer,
    uploadMs,
    exportMs,
    comparison,
    strengths,
    beforeInvalid,
    rollback,
    natural,
    transparent,
    fatalErrorBlocksExport: !unexpectedDownload,
    errors,
  };
  console.log(JSON.stringify(result));
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.stop();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
