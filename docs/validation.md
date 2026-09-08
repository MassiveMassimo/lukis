# Testing and benchmarks

Use Node.js 24 and pnpm 11.1.1. Browser and GPU tests currently require Helium at
`/Applications/Helium.app/Contents/MacOS/Helium` on macOS and a hardware WebGPU
adapter for GPU verification.

`pnpm check` runs formatting, lint, Astro checking, unit and browser tests,
GPU verification, and the production build. `pnpm test:browser` runs the browser
suite with WebGPU and again with WebGPU disabled to exercise WebGL2. Tests use
isolated servers and disposable browser profiles. `LUKIS_TEST_RENDERER` is a
test-process setting, not a production URL parameter or user preference.

## Image and interaction contracts

Browser checks cover upload, replacement, restart, export, image orientation and
proportions, sliders, pointer ownership, motion timing, reduced motion, themes,
error recovery, failed WebGPU startup, failed WebGL2 replacement allocation, and
both graphics APIs unavailable. Motion checks verify message exit overlap,
rapid reversal, intermediate monochrome frames, and stable preview alignment.
Spring-curve tests cover visual duration and physical settling separately.

The optical default comes from the approved center-wave prototype inspired by
the [NameDrop reference](https://www.youtube.com/watch?v=xU3HryTsuVw). Its 1.6 s
center reveal uses cubic-out easing and a wide radial gradient (Feather 0.25,
a 0.5-short-side transition). Reveal can finish after the bounds resize; shorter
reveals still align with the end of that resize. Normal motion uses shader alpha
and localized shader blur, without a second whole-image opacity or CSS blur ramp.
Reduced motion retains the short opacity fade.

The approved B impact wave now drives both renderers. One clock moves a compact
Gaussian fold and its lower trailing shoulder outward. It launches over 226.7 ms,
broadens with travel distance, and loses amplitude through spatial damping.
There is no separate travel easing, spring handoff, center residual, or fade.
The wave has a smooth C2 boundary and reaches exact rest before the flat sample.
Normals drive refraction, neutral area-light reflection, chromatic sampling,
and localized blur. The origin stays at the center.

The default wave lasts 2.8 s, with 1.2 s bounds and a 1.6 s mask reveal.
The approved tuning uses Strength 2, Height 0.635, Width 0.33, Broadening 0.036,
and Refraction 0.5. Wider images, wider folds, and extra echoes increase the required travel
distance within the selected duration. This keeps valid narrow images from locking
the app for minutes. The endpoint includes the broad trailing shoulder, last echo,
and finite-difference normal samples. Reveal duration does not stretch the wave;
a longer reveal continues after the wave reaches rest.

Both renderers reuse the cached painting. Displacement, dispersion, and blur taper
across a broad boundary region to prevent stretched edge texels. Presentation uses
premultiplied alpha. Exports remain opaque and unchanged. Reduced motion skips the
wave. GPU checks cover immediate mask growth, visible early deformation, motion
after the mask completes, exact final pixels, filter-pass counts, and PNG exports.
Validate WGSL with `pnpm exec vgpu check src/shaders/present.wgsl --require-validation`.

In development, open Ripple in DialKit 2.0's vanilla panel. Appearance controls
include Strength, Height, Width, Broadening, Refraction, Dispersion, Color Boost,
Sheen, Shading, Feather, Blur Px, Count, Spacing, and Echo.
Dispersion controls the RGB sampling distance. Color Boost controls its visible
contribution. Defaults are Dispersion 0.42, Color Boost 5.4, and Blur Px 14.
The color comes from shifted image samples, with no colored edge glow.
Blur uses nine weighted samples and grows with local deformation.
Count supports one to six waves. Overlapping broad waves can merge; Count does
not guarantee separately visible crests. Echo zero leaves only the first wave.
Width and Spacing use short-side units. Broadening is width growth per travel unit.
Its range stays below the rate at which the trailing shoulder would stop exiting.

Timing exposes Duration Ms, Start Offset Ms, Attack Ms, and Damping.
Duration controls the wave's total travel time. Attack controls its initial onset.
Higher Damping weakens the wave sooner as it moves outward. Negative offsets
pre-advance the wave at mask entry. The mask retains the Reveal transition's
own duration and easing. Old Custom, Travel, and Settle controls are removed.

Replay reveal uses the cached image. Each replay captures its settings so edits
cannot invalidate its end bound mid-flight. Edits apply on the next replay and
update immediately in paused previews. Preview > Use Timeline scrubs the same
sampler and reveal easing as playback. With it off, Reveal Progress and Wave
Progress remain independent. Loop repeats with a configurable gap and stops
scheduling when disabled, paused, or under reduced motion.

Load impact default restores the approved ripple and 1.6 s Reveal settings.
Use this action to replace older persisted tuning. Reset ripple restores only
Ripple and leaves Bounds, Reveal, and Sound intact. Edits and saved versions
continue to persist through DialKit. Removed paths are discarded by its existing
reconciliation. No storage migration is needed.

Browser tests cover persistence, paused tuning, replay, reset, loop stopping,
reduced motion, and unchanged exports in both renderers. Unit tests cover the
approved initial trajectory, duration, offsets, deterministic reverse scrubbing,
and smooth completion across extreme supported proportions and control ranges.
The long bounds-overlap check measures the revealed marker after the wave passes.
Partially masked pixels are covered by GPU mask checks. DialKit stays development-only.

`pnpm test:gpu` compares decoded PNG pixels against the tracked renderer in
`test/fixtures/painterly-reference.ts`. It generates synthetic input and uses
the tracked natural image. It checks transparent input, filter reuse, failed
replacement rollback, and device-error handling. It runs WebGPU, WebGL2 with
floating-point targets, and WebGL2 with the float extension disabled. It verifies
the selected canvas context, so an unintended fallback cannot pass as WebGPU.
Pixel comparisons read PNG exports directly from the isolated fixture. Each
renderer also performs a real browser download and checks that its pixels match
the exported PNG. Repeated pixel comparisons do not trigger browser downloads.
It needs no separate reference
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

Fallback comparisons on 7 September 2026 passed the existing mean RGB error
limit of 0.1/255 for WebGL2 with floating-point targets. Without the extension,
the RGBA8 cache adds rounding before blending; tested mean error stayed below
0.24/255 (limit 0.3). Both WebGL2 paths kept fewer than 0.01% of channels more
than two levels from the reference. Original pixels and transparent input
matched exactly, and failed replacements preserved byte-identical exports.
These checks run on Helium on macOS with capabilities disabled for fallback
coverage. They do not establish compatibility with every browser or GPU driver.

## Production smoke check

`node test/production-smoke.ts <url> <output-directory>` exercises upload, PNG
download, themes, mobile layout, and restart, and reports browser errors.
Local tests do not establish that a deployed site works. Run this check against
the target URL.

Set `LUKIS_TEST_RENDERER=webgl2` for a second smoke run with WebGPU disabled.
The smoke test checks the active canvas context and that the unused renderer's
JavaScript was not downloaded.

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
