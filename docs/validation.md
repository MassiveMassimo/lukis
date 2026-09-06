# Testing and benchmarks

Use Node.js 24 and pnpm 11.1.1. Browser and GPU tests currently require Helium at
`/Applications/Helium.app/Contents/MacOS/Helium` on macOS and a hardware WebGPU
adapter for GPU verification.

`pnpm check` runs formatting, lint, Astro checking, unit and browser tests,
GPU verification, and the production build. `pnpm test:browser` runs the browser
suite separately. Tests use isolated servers and disposable browser profiles.

## Image and interaction contracts

Browser checks cover upload, replacement, restart, export, image orientation and
proportions, sliders, pointer ownership, motion timing, reduced motion, themes,
error recovery, and unavailable WebGPU. Motion checks verify message exit overlap,
rapid reversal, intermediate monochrome frames, and stable preview alignment.
Spring-curve tests cover visual duration and physical settling separately.

`pnpm test:gpu` compares decoded PNG pixels against the tracked renderer in
`test/fixtures/painterly-reference.ts`. It generates synthetic input and uses
the tracked natural image. It checks transparent input, filter reuse, failed
replacement rollback, and device-error handling. It needs no separate reference
checkout or existing server. Temporary images, the server, and the browser are
removed on completion or failure.

Pixel comparisons disable Helium's canvas privacy noise only in disposable test
processes. They do not change normal browser settings or use software-renderer
flags.

The migration comparison on 6 September 2026 found exact matches for original
pixels, transparent input, and preserved exports after failed replacements.
Filtered synthetic and natural images had mean RGB error below 0.041 on the
0–255 scale. Fewer than 0.001% of pixels had a channel error above 2. Rare
variance-sector boundaries differ because of floating-point arithmetic;
filtered output is not universally byte-identical.

## Production smoke check

`node test/production-smoke.ts <url> <output-directory>` exercises upload, PNG
download, themes, mobile layout, and restart, and reports browser errors.
Local tests do not establish that a deployed site works. Run this check against
the target URL.

## Historical performance comparison

On 6 September 2026, before subsequent motion refinements, three alternating
runs compared local Next.js and Astro production builds on the same machine.
Each run used a fresh Helium process, a 1280 × 960 viewport, reduced motion, and
the same 800 × 600 input. These medians include browser automation overhead.
They are historical diagnostic samples, not current cross-device guarantees.

| Measure                          | Next.js version | Astro version |
| -------------------------------- | --------------: | ------------: |
| Loaded JavaScript, decoded bytes |         737,324 |       199,000 |
| Loaded font bytes                |         276,808 |        70,504 |
| Upload until controls are ready  |          262 ms |        244 ms |
| PNG download                     |           89 ms |         95 ms |
| Paint key press plus two frames  |           38 ms |         36 ms |

JavaScript decreased by 73%, and loaded font bytes decreased by 75%. Interaction
times were similar in this small sample; export was slightly slower. Network
timing was not compared because the servers used different compression settings.

Run `node test/migration-benchmark.ts <url> <output-directory>` against a build
to collect the same diagnostic. Comparing versions requires an independently
available build of each version.
