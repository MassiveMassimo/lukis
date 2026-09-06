# Architecture

Styling uses Tailwind utilities in the owning Astro component. `UploadPreview`
owns the image layers and messages, `FrameGuides` owns guide effects, `ThemeToggle`
owns the theme control, and `ElasticSlider` and `Button` own their controls.
Complex masks and press effects stay in scoped component CSS. Dynamic message
selectors are scoped through their stable parent. Keep animated transforms in
the `transform` property so CSS individual transforms do not compound Anime.js.
`global.css` contains Tailwind configuration, semantic theme tokens, document
defaults, and the document-wide theme transition. `fonts.css` contains font faces.

Lukis is a static Astro image editor with plain TypeScript, Tabler SVGs,
Tailwind v4, Sunghyun Sans, and a Fluid Functionalism button port. The production
application has no React runtime or server-side image processing.

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

## Hosting and verification

`pnpm build` produces `dist/` for static hosting. Cloudflare Workers Static Assets
serves it without a Worker script or Astro SSR adapter. See the README for
deployment commands and [testing and benchmarks](validation.md) for verification.
Use the tracked image reference and browser tests to check processing and motion.
