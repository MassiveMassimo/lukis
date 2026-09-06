# Lukis

- This is a static Astro app. Use Astro components and plain TypeScript. Do not add React or TSX.
- Use Anime.js for motion, vgpu for WebGPU, Tailwind v4, and Tabler SVG icons.
- Preserve the Papari-Kuwahara filter, local image custody, opaque PNG output, and 1600px limit.
- Paint changes must reuse the filtered image. Refilter only when the image or Brush changes.
- Keep image replacement transactional. A failed replacement must preserve the last valid export.
- Preserve keyboard and pointer slider input, reduced motion, theme persistence, and image proportions during motion.
- Run `pnpm check` and `pnpm test:browser`. Browser tests use Helium with isolated profiles.
- Use the saved Next.js/Motion reference for visual comparisons. See `docs/migration.md`.
- Keep deployment status explicit. Local changes do not prove a personal-account transfer or deployment.
