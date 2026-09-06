import assert from "node:assert/strict";
import { readFile, stat, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const json = async (path: string) => JSON.parse(await read(path));

test("the hover reference stays within its 300 KB transfer budget", async () => {
  const stylesheet = await read("src/styles/app.css");
  const reference = stylesheet.match(/\.dropzone-reference\s*\{[^}]*url\(['"]\/([^'"]+)['"]\)/);
  assert.ok(reference, "The hover reference must use a local asset.");
  assert.ok((await stat(new URL(`public/${reference[1]}`, root))).size <= 300_000);
});

test("the app uses Astro without a React runtime", async () => {
  const pkg = await json("package.json");
  assert.equal(pkg.scripts.dev, "astro dev");
  assert.equal(pkg.scripts.build, "astro build");
  assert.match(pkg.devDependencies.astro, /^7\./);
  for (const name of ["next", "react", "react-dom", "motion", "@tabler/icons-react"]) {
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(pkg.devDependencies[name], undefined);
  }
  assert.match(pkg.dependencies.animejs, /^4\./);
  assert.match(pkg.dependencies.vgpu, /^0\./);
  assert.match(pkg.dependencies.dialkit, /^2\./);
  const files = await readdir(new URL("src", root), { recursive: true });
  assert.equal(
    files.some((path) => /\.[jt]sx$/.test(path)),
    false,
  );
  assert.equal((await json("tsconfig.json")).extends, "astro/tsconfigs/strict");
});

test("Tailwind v4 and the formatter share the application stylesheet", async () => {
  const pkg = await json("package.json");
  assert.match(pkg.devDependencies.tailwindcss, /^4\./);
  assert.match(pkg.devDependencies["@tailwindcss/vite"], /^4\./);
  assert.equal((await json(".oxfmtrc.json")).sortTailwindcss.stylesheet, "./src/styles/global.css");
  assert.match(await read("src/styles/global.css"), /^@import "tailwindcss"/);
  assert.match(await read("src/styles/fonts.css"), /SunghyunSans-Regular\.subset\.0\.woff2/);
});

test("the Astro route processes images locally and loads the GPU module separately", async () => {
  const page = await read("src/pages/index.astro");
  const app = await read("src/lib/app.ts");
  const processor = await read("src/lib/processor.ts");
  assert.match(page, /name="robots" content="noindex, nofollow"/);
  assert.match(app, /import\("\.\/processor"\)/);
  assert.doesNotMatch(app + processor, /\bfetch\s*\(|XMLHttpRequest/);
  assert.doesNotMatch(processor, /getContext\(["']webgl/);
  assert.match(processor, /image\.brush !== brush/);
});
