# Astro migration validation

Validated on 6 September 2026 with Node.js 24, pnpm 11.1.1, and Helium on macOS.
The comparison source is the local `archive/nextjs-motion-2026-09-06` tag.

## Runtime and image checks

- All 33 browser tests passed. These cover upload, replacement, restart, export,
  image orientation and proportions, elastic sliders, pointer ownership,
  configurable motion timing, reduced motion, themes, and unavailable WebGPU.
- All 21 unit and static contract tests passed. Formatting, lint, Astro checking,
  and the static production build passed. The production dependency audit found
  no known vulnerabilities.
- The static production smoke check passed at desktop and mobile sizes. Upload,
  PNG export, themes, and restart worked without browser errors.
- A separate read-only review accepted the GPU resource lifetime, failure paths,
  animation cleanup, and control-state fixes without blocking findings.

The follow-up motion repair passed `pnpm check` with all 54 tests. New browser
checks cover error-text and icon exit overlap, rapid theme reversal, intermediate
monochrome filter/mask frames, reversal during that transition, reduced-motion
preview fading, and suppression of slider stretch. The original timing limits
remain unchanged. Timing tests now timestamp DOM samples when the callback runs;
the first rAF timestamp could be hundreds of milliseconds older than that sample
after startup/GPU work. Readiness checks also wait for the upload control to be
enabled after the fade.

The separate `pnpm test:browser` run also passed all 33 cases. A final guard for
synchronous reduced-motion completion was followed by clean static checks, five
passing affected browser tests, and a fresh build. The rebuilt static preview
passed desktop/mobile upload, export, theme, and restart smoke checks with no
browser errors. These repairs have only been validated locally by this task.

Calibrated spring curves matched the archived Motion generator within 3e-16 in
the tested physics and visual-duration configurations. Slider settling times
also matched at the same sampling interval. Anime.js remains the animation
engine. A separate review found no required motion-repair changes after checking
the original generator's settling behavior.

The GPU checks compare decoded PNG pixels against the saved renderer. Original
pixels, transparent input, and the preserved export after a failed replacement
matched exactly. Filtered synthetic and natural images had mean RGB error below
0.041 on the 0–255 scale. Fewer than 0.001% of pixels had a channel error above 2.
Rare variance-sector boundaries differ because of floating-point arithmetic;
filtered output is not universally byte-identical.

Source uploads use premultiplied alpha to preserve the saved renderer's handling
of transparent pixels. Paint changes leave the filter-pass count unchanged;
Brush changes rebuild the cached result. An injected native GPU error blocks
export and leaves a persistent failure state.

Helium's canvas privacy noise was disabled only in disposable test processes for
pixel comparisons. The user's normal browser settings were not changed. GPU
tests used the hardware adapter, without software-renderer flags.

## Component styling follow-up

The component styling cleanup passed `pnpm check` with all 62 tests, followed by
a separate `pnpm test:browser` run with all 41 tests passing. Global UI selectors
were replaced with utilities in the owning Astro components and scoped CSS for
complex effects. The upload/reveal DOM and animation hooks were preserved.

Eight before/after production captures cover light and dark themes, desktop and
mobile widths, and empty and uploaded-image states. Every sampled computed style
and element rectangle matched. Each screenshot differed by only one theme-icon
edge pixel, with a maximum channel difference of 2/255. The standalone button
fixture also passed checks for all 20 examples in both themes, including loading
recovery. Compact evidence is in `analysis-output/style-colocation` (about 560 KB).

## Performance measurements

Before the follow-up motion repair, three alternating runs compared local
production builds on the same machine.
Each run used a fresh Helium process, a 1280 × 960 viewport, reduced motion, and
the same 800 × 600 input. Timings below are medians and include browser automation
overhead. They are diagnostic samples, not cross-device performance guarantees.

| Measure                          | Saved Next.js version | Astro version |
| -------------------------------- | --------------------: | ------------: |
| Loaded JavaScript, decoded bytes |               737,324 |       199,000 |
| Loaded font bytes                |               276,808 |        70,504 |
| Upload until controls are ready  |                262 ms |        244 ms |
| PNG download                     |                 89 ms |         95 ms |
| Paint key press plus two frames  |                 38 ms |         36 ms |

JavaScript decreased by 73%, and loaded font bytes decreased by 75%. Interaction
times were similar in this small sample; export was slightly slower. The Astro
JavaScript files total 66,077 bytes when gzip-compressed locally. Network timing
was not compared because the local servers used different compression settings.

Run `node test/migration-benchmark.ts <url> <output-directory>` to repeat the
diagnostic. Run `node test/production-smoke.ts <url> <output-directory>` against
an accessible production deployment. The GPU comparison fixture and runner are
in `test/fixtures/buttons` and `test/gpu-verification.ts`. Run `pnpm test:gpu`
to repeat the GPU comparison. It is also included in `pnpm check`.
The command uses Helium with a hardware WebGPU adapter. It creates an isolated
fixture server on an available port, generates its synthetic input, and uses the
tracked natural image. No existing server or ignored input file is required.
It prints metrics and removes its temporary images, server, and browser on
completion or failure.

Compact screenshots, PNG comparisons, and measurements are retained locally in
the ignored `analysis-output` directory. Local test acceptance does not by itself
prove remote ownership or a production deployment.
# Cloudflare checkout verification, 6 September 2026

Verified in the independent `/Users/imo/Documents/GitHub/lukis` checkout with
Node.js 24.19.0 and pnpm 11.1.1. Formatting, lint, type checks, all 62 tests,
and the separate 41-test Helium suite passed. The GPU check timed out waiting
for a download on its first run and passed unchanged when run on its own.
The production build and Wrangler strict dry run passed with 79 static files.
The production dependency audit reported no known vulnerabilities.
These checks do not establish a live Cloudflare deployment.
