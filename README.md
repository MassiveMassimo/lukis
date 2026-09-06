# Lukis

Lukis turns a local PNG, JPEG, or WebP image into a painting. Adjust Paint and
Brush, then download a PNG. Images stay in the browser.

Built with Astro, plain TypeScript, Anime.js, vgpu, Tailwind CSS v4, Tabler icons,
and self-hosted Sunghyun Sans. The production app has no React runtime.

## Development

Use Node.js 24 and pnpm 11.1.1.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm check
pnpm test:browser
```

WebGPU must be available. There is no WebGL fallback. Input files are limited to
25 MB. Output is capped at 1600 pixels on the longest edge.

The development build includes vanilla DialKit for Bounds, Reveal, and Sound.
Production builds omit the tuning panel. Theme selection supports System,
Light, and Dark.

## Performance and image quality

The GPU pipeline caches the full painterly result for the current image and
brush size. Paint changes use a separate blend pass. PNG export reads from a
persistent output texture. Image replacement commits only after processing
succeeds.

The migration checks compare decoded PNGs with the saved renderer and exercise
orientation, image proportions, replacement, slider input, reduced motion,
theme changes, and unavailable WebGPU.

The production migration uses 73% less JavaScript and 75% fewer loaded font
bytes in the local comparison. Interaction times were similar. See the
[validation results](docs/validation.md) for measurements and limits.

## Hosting

`pnpm build` writes the static site to `dist/`. Vercel needs the Astro preset,
Node.js 24, and the pinned pnpm version. No package registry token or image
processing server is required.

The personal Vercel project `lukis` exists in `massivemassimos-projects` and this
checkout is linked to it. It uses the Astro preset and has no project environment
variables. Local validation is complete. The GitHub move to `MassiveMassimo/lukis`
and production deployment are pending the decision about historical file
contents. The previous hosted version remains unchanged.

## Reference and recovery

The previous Next.js and Motion version is preserved by tag
`archive/nextjs-motion-2026-09-06`. A separate local worktree and a complete
Git bundle are available at:

- `/Users/imo/Documents/GitHub/lukis-nextjs-reference`
- `/Users/imo/Documents/GitHub/lukis-nextjs-reference.bundle`

See [the migration contract](docs/migration.md) and
[the Astro button port](docs/astro-button.md). Third-party notices are in
`licenses/` and `public/fonts/sunghyun-sans/OFL.txt`.
