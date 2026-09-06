import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  devToolbar: { enabled: false },
  vite: {
    cacheDir: ".astro/vite",
    optimizeDeps: { include: ["animejs", "cuelume", "dialkit/vanilla", "number-flow", "vgpu"] },
    plugins: [tailwindcss()],
    css: { postcss: { plugins: [] } },
  },
});
