import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  publicDir: "../../../public",
  devToolbar: { enabled: false },
  vite: {
    cacheDir: ".astro/vite",
    // Preload the lazy renderer dependency before a test uploads its image.
    optimizeDeps: { include: ["vgpu"] },
    plugins: [tailwindcss()],
    // This fixture coexists with the current Next.js PostCSS configuration.
    css: { postcss: { plugins: [] } },
  },
});
