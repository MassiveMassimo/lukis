/* oxlint-disable no-await-in-loop -- GPU state and paired exports must be tested in order. */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { dev } from "astro";

const root = fileURLToPath(new URL("../", import.meta.url));
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
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (options) {
      const device = await request.call(this, options);
      Object.defineProperty(window, "testDevice", { value: device, configurable: true });
      return device;
    };
  });
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
  const uploadMs = performance.now() - start;
  const exportStart = performance.now();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PNG" }).click(),
  ]);
  await download.saveAs(`${directory}/output.png`);
  const exportMs = performance.now() - exportStart;
  const [referenceDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download reference" }).click(),
  ]);
  await referenceDownload.saveAs(`${directory}/reference.png`);
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
  const comparison = await comparePaths([`${directory}/reference.png`, `${directory}/output.png`]);
  async function savePair(name: string) {
    for (const [label, suffix] of [
      ["Download PNG", "gpu"],
      ["Download reference", "gl"],
    ]) {
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: label, exact: true }).click(),
      ]);
      await file.saveAs(`${directory}/${name}-${suffix}.png`);
    }
    return comparePaths([`${directory}/${name}-gl.png`, `${directory}/${name}-gpu.png`]);
  }
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
    assert.ok(sample.meanAbsoluteError < 0.1, "Average RGB error must remain below 0.1 of 255");
    assert.ok(
      sample.fractionOver2 < 0.0001,
      "Large rounding differences must remain below 0.01% of channels",
    );
  }
  assert.deepEqual(comparison.dimensions, [
    { width: 800, height: 600 },
    { width: 800, height: 600 },
  ]);
  await page.evaluate(() => {
    const device = (window as typeof window & { testDevice: GPUDevice }).testDevice;
    device.dispatchEvent(
      new GPUUncapturedErrorEvent("uncapturederror", {
        error: new GPUOutOfMemoryError("Injected GPU memory failure"),
      }),
    );
  });
  await page.getByRole("status").filter({ hasText: "Injected GPU memory failure" }).waitFor();
  let unexpectedDownload = false;
  page.once("download", () => {
    unexpectedDownload = true;
  });
  await page.getByRole("button", { name: "Download PNG" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Error: Injected GPU memory failure" })
    .waitFor();
  assert.equal(unexpectedDownload, false);
  assert.deepEqual(errors, []);
  const result = {
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
