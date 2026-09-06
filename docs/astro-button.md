# Astro button port

`src/components/Button.astro` adapts the [Fluid Functionalism button](https://www.fluidfunctionalism.com/r/button.json), checked on 2026-09-06. Its MIT notice is in `licenses/fluid-functionalism.txt`.

The component renders native HTML with Tailwind v4 utilities and scoped CSS for the press effect. Import `src/styles/global.css` and use `@tailwindcss/vite`, as shown in the fixture configuration. It has no React, Motion, or Anime.js dependency. It preserves the upstream surface press effect, icon stroke transition, sizes, variants, and infinity spinner. Reduced motion disables transitions and leaves a static loading glyph. The current upstream button does not animate font weight.

Use `label`, `variant`, `size`, `disabled`, and `loading` props. Standard button attributes pass through. Put inline SVG in the `icon` or `trailing-icon` named slot. Icon buttons use `label` as their accessible name. Native `type="button"` is the default; pass `type="submit"` for form submission.

For a client operation, import `setButtonLoading` from `src/lib/button.ts`. Call it with `true` before the operation and `false` in `finally`. It keeps the label and dimensions in place, sets `aria-busy`, blocks duplicate clicks, and restores the prior disabled state. Announce the result through the application's status region. The component itself ships no JavaScript.

Colors inherit the application's `--background`, `--foreground`, `--accent`, `--border`, `--muted-foreground`, `--hover`, `--active`, and `--focus-ring` tokens. Shape uses `--control-radius`. The React-only Slot API and context providers are not part of this port.

Build the standalone preview with `pnpm exec astro build --root test/fixtures/buttons`. Serve it with `python3 -m http.server 4186 --bind 127.0.0.1 --directory test/fixtures/buttons/dist`. This fixture is separate from the main Astro page, which uses the same button component.

The Astro build, `astro check`, formatting, lint, and Helium interaction checks cover this port. TypeScript 6.0.3 supplies the programmatic compiler API required by Astro's checker.

# Font and icons

The Astro UI uses Sunghyun Sans with Tabler outline SVGs and Tailwind CSS 4.3.3. Tabler SVG imports resolve at build time through `@tabler/icons/outline/<name>.svg`; they do not use the React package. Its MIT notice is in `licenses/tabler-icons.txt`.

Sunghyun Sans is self-hosted under `public/fonts/sunghyun-sans`, pinned to upstream commit `47224e4e2a3a0c628414e25d8b16f5021207f9d1`. The SIL Open Font License and original copyright notices are in `OFL.txt` beside the font files. `src/styles/fonts.css` selects the author's unchanged dynamic subsets for weights 400, 500, and 600. Unicode ranges let the browser fetch only the required character chunks. The regular Latin subset is preloaded; the other files load on demand. `font-sans` maps to Sunghyun Sans in Tailwind's CSS theme.

# Next.js and Motion reference

The pre-migration source is preserved at commit `9edeeb5a7dc4cf2ba2d0bd2725102c2bcfe732b5` by the local annotated tag `archive/nextjs-motion-2026-09-06`. A separate detached worktree is at `/Users/imo/Documents/GitHub/lukis-nextjs-reference`. It contains the complete tracked source and original lockfile. Dependencies and build artifacts are not copied.

For a fresh reference checkout, run `git worktree add --detach <reference-directory> archive/nextjs-motion-2026-09-06`, then `pnpm install --frozen-lockfile` in that directory. Use Node 24 and pnpm 11.1.1 as recorded in its package manifest. Do not merge the reference into the Astro branch. The tag and worktree are local; neither has been pushed.

A standalone backup at `/Users/imo/Documents/GitHub/lukis-nextjs-reference.bundle` also contains the complete Git history reachable from this tag. `git bundle verify` passed. It can restore the reference even if the working repository is unavailable: `git clone --branch archive/nextjs-motion-2026-09-06 /Users/imo/Documents/GitHub/lukis-nextjs-reference.bundle <restore-directory>`.
