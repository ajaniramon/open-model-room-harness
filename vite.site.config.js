import { defineConfig } from "vite";

export default defineConfig({
  root: "site",
  base: "./",
  build: {
    outDir: "../site-dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
