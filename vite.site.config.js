import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "site",
  base: "./",
  build: {
    outDir: "../site-dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "site/index.html"),
        "build-jam": resolve(import.meta.dirname, "site/build-jam.html"),
      },
    },
  },
});
