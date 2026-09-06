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

`pnpm build` writes the static site to `dist/`. Cloudflare Workers Static Assets
serves that directory without a Worker script or Astro SSR adapter. Image
processing stays in the browser. No package registry token is required.

Use Node.js 24 and the pinned pnpm version. Sign in with `pnpm exec wrangler login`,
then run `pnpm deploy:check` to validate the upload or `pnpm deploy` to publish.
The Cloudflare account and Worker name are set in `wrangler.jsonc`.

The dedicated checkout is `/Users/imo/Documents/GitHub/lukis`. Its remote is the
private [MassiveMassimo/lukis](https://github.com/MassiveMassimo/lukis) repository.
See [the migration status](docs/migration.md) for verified publication status.

## Reference and recovery

The previous Next.js and Motion version, including its original history and
archive tag, is preserved in a separate local worktree and complete Git bundle:

- `/Users/imo/Documents/GitHub/lukis-nextjs-reference`
- `/Users/imo/Documents/GitHub/lukis-nextjs-reference.bundle`

See [the migration contract](docs/migration.md) and
[the Astro button port](docs/astro-button.md). Third-party notices are in
`licenses/` and `public/fonts/sunghyun-sans/OFL.txt`.
