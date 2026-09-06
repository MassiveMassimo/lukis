import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  publicDir: "../../../public",
  devToolbar: { enabled: false },
  vite: {
    cacheDir: ".astro/vite",
    plugins: [tailwindcss()],
    // This fixture coexists with the current Next.js PostCSS configuration.
    css: { postcss: { plugins: [] } },
  },
});
