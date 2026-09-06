# Lukis migration contract

Styling uses Tailwind utilities in the owning Astro component. `UploadPreview`
owns the image layers and messages, `FrameGuides` owns guide effects, `ThemeToggle`
owns the theme control, and `ElasticSlider` and `Button` own their controls.
Complex masks and press effects stay in scoped component CSS. Dynamic message
selectors are scoped through their stable parent. Keep animated transforms in
the `transform` property so CSS individual transforms do not compound Anime.js.
`global.css` contains Tailwind configuration, semantic theme tokens, document
defaults, and the document-wide theme transition. `fonts.css` contains font faces.

Move this image editor to a personal Astro project named Lukis. Preserve appearance and behavior except the approved logo, Sunghyun Sans font, and Fluid Functionalism button port. Keep Tabler SVGs and Tailwind v4. Remove React, TSX, Next.js, Motion, current company branding, and company package dependencies.

Use Anime.js for DOM motion, vgpu for browser-local image processing, and DialKit vanilla for development tuning. WebGPU is required; show a persistent unsupported-browser message when unavailable. There is no WebGL fallback or server image processing.

Paint and Brush values use the vanilla `number-flow` custom element, rendered
initially by Astro. Preserve Paint's percent suffix and Brush's single decimal
place. Slider ARIA values update immediately, independent of digit animation.
Keep NumberFlow's reduced-motion support enabled. Do not add its React wrapper.

Preserve PNG/JPEG/WebP input validation, 25 MB input cap, 1600 px output cap, aspect ratios, image orientation, Papari-Kuwahara filter, Paint and Brush controls, elastic slider behavior, upload/replacement/restart transitions, sounds, and system/light/dark themes. Keep full-color image pixels separate from monochrome drop-target treatment. Hidden controls must be inert. Honor reduced motion and storage failures.

Message text and icons must remain mounted until their exit finishes. Reversing
a transition must start from the current appearance. The existing-image
monochrome treatment interpolates opacity, filter, and both mask gradients over
the reference's 600 ms curve. Reduced motion removes slider stretch and preview
movement, while retaining a 120 ms preview fade.
Temporarily disabled controls retain their normal opacity. Keep their disabled
and inert input guards during processing and transitions.
Keep the preview grid column constrained to the stage width. The bounds may
overshoot that width, but the frame and monochrome reference must stay centered.

Anime.js runs the animations with calibrated custom spring curves. Its native
spring mass limits and duration semantics do not match the saved reference.
Bounds and reveal use curves normalized at the configured visual duration;
slider springs continue to their distance-sensitive rest thresholds. Preserve
that distinction when changing the motion adapter.

Cache the painted result by source image and brush setting. Strength changes only blend the cache with the original image. Explicitly use byte-normalized, non-sRGB textures with linear clamp-to-edge sampling and opaque output, as in the old renderer. Prepare replacement GPU resources before committing them. An unsuccessful replacement must leave the old image and export usable. Export and outgoing snapshots read a persistent output target. Handle device loss as a persistent processing error.

Group Download and Copy on the right, with Restart on the left. Both export actions
keep their current icon while disabled and pending. Do not show a spinner. Only a
successful action swaps to the check, which draws once with Anime.js and then
returns to the action icon. Reduced motion uses a static check. Copy writes the
same opaque PNG as Download, through the browser clipboard API. Start the clipboard
write in the click gesture with a promised PNG. Permission or encoding failures
must restore the action icon and preserve the last valid image for retry.

Validate with existing interaction contracts, new GPU output/pixel checks, browser motion evidence, and before/after measurements. `analysis-output/baseline` contains the initial same-machine, reduced-motion baseline at 800 × 600. Single samples are diagnostic, not general performance claims.

After local acceptance, publish GitHub to `MassiveMassimo/lukis` and host with
Cloudflare Workers Static Assets. The static Astro build does not need an SSR
adapter or Worker script. Verify live ownership and deployment separately.
Preserve the original source and history locally using the reference worktree,
archive tag, and standalone bundle described in `astro-button.md`.

Implementation order: GPU proof and exports; Astro UI and motion; interaction/visual/performance acceptance; branding and dependency audit; personal account migration and deployment.

Local acceptance is complete. See [the validation results](validation.md) for
test coverage, image parity, and measured performance. The current tree has no
old company branding.

On 6 September 2026, source commit `b502e45` was deployed to the personal Vercel
project at [lukis-two.vercel.app](https://lukis-two.vercel.app). Vercel reports
production Ready. Live Helium checks passed upload, PNG export, themes, mobile
layout, and restart, with no browser errors.

The independent checkout is `/Users/imo/Documents/GitHub/lukis`, on `main`, with
the private [MassiveMassimo/lukis](https://github.com/MassiveMassimo/lukis) as
`origin`. The original working checkout remains intact. The personal copy
retains commit history with explicit former branding sanitized, as approved.
All reachable file contents, paths, and commit objects passed the branding scan.
The history rewrite left the current source tree unchanged.
Historical snapshots may reference renamed packages that no longer resolve.
Use the untouched local reference and bundle to run the original application.

Cloudflare Workers Static Assets serves
[lukis.mhmmadjid.workers.dev](https://lukis.mhmmadjid.workers.dev) in the personal
account configured in `wrangler.jsonc`. The sanitized history and accepted app
changes are pushed to personal GitHub. The existing Vercel site remains available
as a fallback. Git-connected deployment is not configured; use `pnpm deploy`.
Live Helium checks passed upload, PNG export, themes, mobile layout, and restart,
with no browser errors. The served HTML, JavaScript, CSS, favicon, and share image
match the local production build byte-for-byte. Share-image metadata uses the
Cloudflare URL. Compact screenshots and the smoke result are retained locally
in `analysis-output/cloudflare-live`.
For rollback after a successful Cloudflare deployment, use `pnpm exec wrangler
rollback` to restore a prior version, then repeat the production smoke check.
