# Painterly

Painterly is an internal, browser-only image tool. It applies the Lukis
Papari-Kuwahara shader to a local PNG, JPEG, or WebP image and exports a PNG.
Images never leave the browser.

## Requirements

- Node.js 24
- pnpm 11.1.1
- Access to `@MassiveMassimo/ui` in GitHub Packages

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm check
pnpm test:browser
```

The local app runs at `http://localhost:3000`.
