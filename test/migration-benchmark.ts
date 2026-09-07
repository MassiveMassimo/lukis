import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:4175";
const directory = process.argv[3] ?? "analysis-output/baseline";
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/Applications/Helium.app/Contents/MacOS/Helium",
  headless: true,
  args: ["--disable-features=HeliumNoiseCanvas"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(directory, "empty.png") });
  const initial = await page.evaluate(() => ({
    navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
    resources: performance.getEntriesByType("resource").map((entry) => entry.toJSON()),
    gpu: "gpu" in navigator,
  }));
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(800, 600);
    for (let y = 0; y < 600; y++) {
      for (let x = 0; x < 800; x++) {
        const i = (y * 800 + x) * 4;
        pixels.data[i] = (x * 17 + y * 3) % 256;
        pixels.data[i + 1] = (x + y * 5) % 256;
        pixels.data[i + 2] = 128 + 110 * Math.sin(x / 31) * Math.cos(y / 27);
        pixels.data[i + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    ctx.fillStyle = "#ee3424";
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = "#2470ee";
    ctx.fillRect(0, 500, 100, 100);
    return canvas.toDataURL("image/png");
  });
  const fixtureBuffer = Buffer.from(fixture.split(",")[1], "base64");
  await writeFile(join(directory, "input.png"), fixtureBuffer);
  const start = performance.now();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: fixtureBuffer });
  await page.getByRole("slider", { name: "Paint", exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('[role="slider"][aria-label="Paint"]')?.closest("[inert]"),
  );
  const uploadMs = performance.now() - start;
  const downloadStart = performance.now();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /Download.*PNG/ }).click(),
  ]);
  await download.saveAs(join(directory, "output.png"));
  const downloadMs = performance.now() - downloadStart;
  await page.screenshot({ path: join(directory, "loaded.png") });
  const adjustmentStart = performance.now();
  await page.getByRole("slider", { name: "Paint", exact: true }).press("ArrowLeft");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const adjustmentMs = performance.now() - adjustmentStart;
  const result = { baseUrl, uploadMs, downloadMs, adjustmentMs, initial, errors };
  await writeFile(join(directory, "metrics.json"), JSON.stringify(result, null, 2));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      uploadMs,
      downloadMs,
      adjustmentMs,
      scriptBytes: initial.resources
        .filter((e) => e.initiatorType === "script")
        .reduce((sum, e) => sum + e.encodedBodySize, 0),
      errors,
    }),
  );
} finally {
  await browser.close();
}
