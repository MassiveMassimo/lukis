import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4189";
const directory = process.argv[3] ?? "analysis-output/production-smoke";
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
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await expect(page).toHaveTitle("Lukis — Make it painterly");
  await expect(page.locator("html")).toHaveAttribute("data-processor-state", "ready");
  assert.equal(await page.locator(".dialkit-root").count(), 0);
  await page.screenshot({ path: join(directory, "desktop-light.png") });
  await page.locator("#theme").click();
  await page.locator("#theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: join(directory, "desktop-dark.png") });
  await page.locator("#image-input").setInputFiles("public/window-reference.webp");
  await expect(page.locator("#download")).toBeEnabled();
  await expect(page.locator(".controls")).not.toHaveAttribute("inert", "");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#download").click(),
  ]);
  assert.match(download.suggestedFilename(), /-lukis\.png$/);
  await download.saveAs(join(directory, "export.png"));
  await page.screenshot({ path: join(directory, "desktop-image.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".canvas-frame")?.getAttribute("data-animating") !== "true",
  );
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
