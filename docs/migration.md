# Lukis migration contract

Move this image editor to a personal Astro project named Lukis. Preserve appearance and behavior except the approved logo, Sunghyun Sans font, and Fluid Functionalism button port. Keep Tabler SVGs and Tailwind v4. Remove React, TSX, Next.js, Motion, current company branding, and company package dependencies.

Use Anime.js for DOM motion, vgpu for browser-local image processing, and DialKit vanilla for development tuning. WebGPU is required; show a persistent unsupported-browser message when unavailable. There is no WebGL fallback or server image processing.

Preserve PNG/JPEG/WebP input validation, 25 MB input cap, 1600 px output cap, aspect ratios, image orientation, Papari-Kuwahara filter, Paint and Brush controls, elastic slider behavior, upload/replacement/restart transitions, sounds, and system/light/dark themes. Keep full-color image pixels separate from monochrome drop-target treatment. Hidden controls must be inert. Honor reduced motion and storage failures.

Cache the painted result by source image and brush setting. Strength changes only blend the cache with the original image. Explicitly use byte-normalized, non-sRGB textures with linear clamp-to-edge sampling and opaque output, as in the old renderer. Prepare replacement GPU resources before committing them. An unsuccessful replacement must leave the old image and export usable. Export and outgoing snapshots read a persistent output target. Handle device loss as a persistent processing error.

Validate with existing interaction contracts, new GPU output/pixel checks, browser motion evidence, and before/after measurements. `analysis-output/baseline` contains the initial same-machine, reduced-motion baseline at 800 × 600. Single samples are diagnostic, not general performance claims.

After local acceptance, move GitHub to `MassiveMassimo/lukis` and Vercel to `massivemassimos-projects/lukis`. Verify live ownership and deployment separately. Preserve the original source and history locally using the reference worktree, archive tag, and standalone bundle described in `astro-button.md`.

Implementation order: GPU proof and exports; Astro UI and motion; interaction/visual/performance acceptance; branding and dependency audit; personal account migration and deployment.

Local acceptance is complete. See [the validation results](validation.md) for
test coverage, image parity, and measured performance. The current tree has no
old company branding.

On 6 September 2026, source commit `b502e45` was deployed to the personal Vercel
project at [lukis-two.vercel.app](https://lukis-two.vercel.app). Vercel reports
production Ready. Live Helium checks passed upload, PNG export, themes, mobile
layout, and restart, with no browser errors.

The private [MassiveMassimo/lukis](https://github.com/MassiveMassimo/lukis)
repository has been created. It is still empty and is not connected to Vercel.
Publishing history is pending the owner's choice between keeping the Astro-era
commits or sanitizing the older commits. The full original history remains in
the local reference and bundle.
