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

## Deployment

Production: [lukis.vercel.app](https://lukis.vercel.app/).
This stable URL follows the latest production deployment in the NLP Labs
Vercel project `lukis`.

Deploy the current working tree with:

```sh
vercel deploy --prod --scope MassiveMassimo
```

The project uses the Next.js preset, Node.js 24, and Corepack to select the
pnpm version from `package.json`. Vercel's existing `NPM_TOKEN` and `NPM_RC`
environment variables provide GitHub Packages access during builds.

Automatic GitHub deployments are not connected yet. An organization admin
must grant the Vercel GitHub App access to `MassiveMassimo/lukis`
before the project can connect to that private repository. Local edits do
not update the live site until deployed.
