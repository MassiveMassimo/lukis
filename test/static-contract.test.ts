import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the initial hover reference stays within its 300 KB transfer budget", async () => {
  const stylesheet = await readFile(new URL("app/globals.css", root), "utf8");
  const reference = stylesheet.match(/\.dropzone-reference\s*\{[^}]*url\("\/([^"]+)"\)/);
  assert.ok(reference, "The hover reference must use a local asset.");
  const asset = await stat(new URL(`public/${reference[1]}`, root));
  assert.ok(asset.size <= 300_000, `The hover reference is ${asset.size} bytes.`);
});

async function readJson(path: string) {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Record<string, unknown>;
}

test("the project uses the requested Next.js and TypeScript toolchain", async () => {
  const packageJson = await readJson("package.json");
  const dependencies = packageJson.dependencies as Record<string, string>;
  const devDependencies = packageJson.devDependencies as Record<string, string>;
  const scripts = packageJson.scripts as Record<string, string>;
  const tsconfig = await readJson("tsconfig.json");
  const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
  const excludedPaths = tsconfig.exclude as string[];

  assert.equal(scripts.dev, "next dev");
  assert.equal(scripts.build, "next build");
  assert.match(dependencies.next, /^16\./);
  assert.match(dependencies.react, /^19\./);
  assert.match(devDependencies.typescript, /^7\./);
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.allowJs, false);
  assert.equal(excludedPaths.includes("test"), false);
  assert.equal(dependencies.vite, undefined);
});

test("Tailwind v4 and OXC share the application stylesheet contract", async () => {
  const packageJson = await readJson("package.json");
  const devDependencies = packageJson.devDependencies as Record<string, string>;
  const scripts = packageJson.scripts as Record<string, string>;
  const formatter = await readJson(".oxfmtrc.json");
  const linter = await readJson(".oxlintrc.json");
  const sortTailwindcss = formatter.sortTailwindcss as Record<string, string>;
  const plugins = linter.plugins as string[];
  const stylesheet = await readFile(new URL("app/globals.css", root), "utf8");

  assert.match(devDependencies.tailwindcss, /^4\./);
  assert.match(devDependencies.oxfmt, /^\d+\./);
  assert.match(devDependencies.oxlint, /^\d+\./);
  assert.equal(scripts.format, "oxfmt --write .");
  assert.equal(scripts.lint, "oxlint .");
  assert.equal(sortTailwindcss.stylesheet, "./app/globals.css");
  assert.ok(plugins.includes("nextjs"));
  assert.ok(plugins.includes("react"));
  assert.match(stylesheet, /^@import "tailwindcss";/);
});

test("the Next.js route mounts the local-only painterly client", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  const layout = await readFile(new URL("app/layout.tsx", root), "utf8");
  const client = await readFile(new URL("components/painterly-app.tsx", root), "utf8");
  const processor = await readFile(new URL("lib/painterly.ts", root), "utf8");

  assert.match(page, /<PainterlyApp\s*\/>/);
  assert.match(layout, /index:\s*false/);
  assert.match(client, /^"use client";/);
  assert.doesNotMatch(`${client}\n${processor}`, /\bfetch\s*\(|XMLHttpRequest/);
});
