# Lukis

- This is a static Astro app. Use Astro components and plain TypeScript. Do not add React or TSX.
- Use Anime.js for motion, vgpu for WebGPU, Tailwind v4, and Tabler SVG icons.
- Keep WebGPU primary and lazy-load WebGL2 on startup failure. Both renderers must meet the same image, caching, export, and motion contracts. Device loss after startup remains a persistent error.
- Prefer Tailwind utilities in Astro markup. Keep complex component effects in scoped styles in the owning component.
- Reserve global CSS for Tailwind configuration, shared semantic tokens, fonts, document defaults, and document-wide theme behavior.
- Preserve Anime.js transform ownership and runtime selectors when moving styles. Scope styles for dynamically created message nodes through a stable parent.
- Preserve the Papari-Kuwahara filter, local image custody, opaque PNG output, and 1600px limit.
- This branch adds the Gouache/impasto effect. Paint and Thickness changes must reuse the underpainting and knife surface. Refilter only when the image or Stroke changes. Cache the half-resolution direction map per image. See `docs/impasto.md`.
- Keep image replacement transactional. A failed replacement must preserve the last valid export.
- Preserve keyboard and pointer slider input, reduced motion, theme persistence, and image proportions during motion.
- Run `pnpm check` and `pnpm test:browser`. Browser tests use Helium with isolated profiles.
- Use `test/fixtures/gouache-reference/painterly.ts` for impasto image comparisons and the browser tests for motion contracts. Keep the earlier `test/fixtures/painterly-reference.ts` for historical comparison. See `docs/validation.md`.
- Keep deployment status explicit. Local checks do not prove a production deployment.
