# Lukis

Try [Lukis](https://lukis.mhmmadjid.workers.dev/).

This experimental branch adds [Gouache and palette-knife rendering](docs/impasto.md).
Adjust Paint, Stroke, and Thickness, then download a PNG. Images stay in the
browser. This branch has not been deployed to the live site linked above.

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

Lukis uses WebGPU when available and automatically loads a WebGL2 renderer if
WebGPU startup fails. Both process images locally with the same controls.
Input files are limited to 25 MB. Output is capped at 1600 pixels on the longest edge.

The development build includes vanilla DialKit for Bounds, Reveal, and Sound.
Production builds omit the tuning panel. Theme selection supports System,
Light, and Dark.

## Performance and image quality

The GPU pipeline caches the full painterly result for the current image and
stroke size. Paint and Thickness changes use a separate lighting and blend pass. PNG export reads from a
persistent output texture. Image replacement commits only after processing
succeeds.

The image checks compare decoded PNGs with the tracked reference renderer and exercise
orientation, image proportions, replacement, slider input, reduced motion,
theme changes, automatic WebGL2 fallback, and unavailable graphics APIs.

The production migration uses 73% less JavaScript and 75% fewer loaded font
bytes in the local comparison. Interaction times were similar. See the
[validation results](docs/validation.md) for measurements and limits.

## Hosting

`pnpm build` writes the static site to `dist/`. Cloudflare Workers Static Assets
serves that directory without a Worker script or Astro SSR adapter. Image
processing stays in the browser. No package registry token is required.

Use Node.js 24 and the pinned pnpm version. Sign in with `pnpm exec wrangler login`,
then run `pnpm deploy:check` to validate the upload or `pnpm deploy` to publish.
Wrangler uses the account selected during login. Set `CLOUDFLARE_ACCOUNT_ID` in
your shell to select another account. The Worker name is set in `wrangler.jsonc`;
change it before deploying your own copy.

## Documentation and attribution

See [the architecture](docs/migration.md), [testing and benchmarks](docs/validation.md), and
[the Astro button port](docs/astro-button.md). Third-party notices are in
`licenses/` and `public/fonts/sunghyun-sans/OFL.txt`.
