# Astro migration validation

Validated on 6 September 2026 with Node.js 24, pnpm 11.1.1, and Helium on macOS.
The comparison source is the local `archive/nextjs-motion-2026-09-06` tag.

## Runtime and image checks

- All 29 browser tests passed. These cover upload, replacement, restart, export,
  image orientation and proportions, elastic sliders, pointer ownership,
  configurable motion timing, reduced motion, themes, and unavailable WebGPU.
- All 17 unit and static contract tests passed. Formatting, lint, Astro checking,
  and the static production build passed. The production dependency audit found
  no known vulnerabilities.
- The static production smoke check passed at desktop and mobile sizes. Upload,
  PNG export, themes, and restart worked without browser errors.
- A separate read-only review accepted the GPU resource lifetime, failure paths,
  animation cleanup, and control-state fixes without blocking findings.

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

## Performance measurements

Three alternating runs compared local production builds on the same machine.
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
in `test/fixtures/buttons` and `test/gpu-verification.ts`.

Compact screenshots, PNG comparisons, and measurements are retained locally in
the ignored `analysis-output` directory. Local test acceptance does not by itself
prove remote ownership or a production deployment.
