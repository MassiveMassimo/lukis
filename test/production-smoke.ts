import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4189";
const directory = process.argv[3] ?? "analysis-output/production-smoke";
const renderer = process.env.LUKIS_TEST_RENDERER === "webgl2" ? "webgl2" : "webgpu";
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
    colorScheme: "light",
  });
  const errors: string[] = [];
  const requestedScripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") requestedScripts.push(request.url());
  });
  if (renderer === "webgl2") {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    });
  }
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await expect(page).toHaveTitle("Lukis — Turn images into paintings");
  await expect(page.locator("html")).toHaveAttribute("data-processor-state", "ready");
  assert.equal(await page.locator(".dialkit-root").count(), 0);
  const zone = page.locator(".dropzone");
  for (const fraction of [0.25, 0.75]) {
    const bounds = (await zone.boundingBox())!;
    const point = {
      x: bounds.x + bounds.width * fraction,
      y: bounds.y + bounds.height * 0.4,
    };
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".drop-light")).toHaveCSS("opacity", "0.38");
    const light = (await page.locator(".drop-light").boundingBox())!;
    assert.ok(
      Math.abs(light.x + light.width / 2 - point.x) < 10 &&
        Math.abs(light.y + light.height / 2 - point.y) < 10,
      `Built light must stay centered on the cursor: ${JSON.stringify({ point, light })}`,
    );
  }
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(directory, "desktop-light.png") });
  await page.locator("#theme").click();
  await page.locator("#theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: join(directory, "desktop-dark.png") });
  await page.locator("#image-input").setInputFiles("public/window-reference.webp");
  await expect(page.locator("#download")).toBeEnabled();
  await expect(page.locator(".controls")).not.toHaveAttribute("inert", "");
  assert.equal(
    await page.evaluate((mode) => !!document.querySelector("canvas")!.getContext(mode), renderer),
    true,
  );
  const unusedRenderer = renderer === "webgl2" ? "processor-webgpu" : "processor-webgl";
  assert.equal(
    requestedScripts.some((url) => url.includes(unusedRenderer)),
    false,
    "Do not download the unused renderer",
  );
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#download").click(),
  ]);
  assert.match(download.suggestedFilename(), /-lukis\.png$/);
  await download.saveAs(join(directory, "export.png"));
  await page.screenshot({ path: join(directory, "desktop-image.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const bounds = document.querySelector(".tool-surface")?.getBoundingClientRect();
    return (
      document.querySelector(".canvas-frame")?.getAttribute("data-animating") !== "true" &&
      bounds &&
      bounds.x >= 0 &&
      bounds.right <= window.innerWidth
    );
  });
  const bounds = await page.locator(".tool-surface").boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({ path: join(directory, "mobile-image.png") });
  await page.locator("#restart").click();
  await expect(page.locator(".controls")).toBeHidden();
  await page.screenshot({ path: join(directory, "mobile-empty.png") });
  assert.deepEqual(errors, []);
  const result = {
    baseUrl,
    browser: "Helium",
    renderer,
    upload: true,
    export: download.suggestedFilename(),
    themes: true,
    mobile: true,
    restart: true,
    errors,
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
