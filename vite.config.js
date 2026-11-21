import { defineConfig } from "vite";

export default defineConfig({
  base: "/baby-video/",
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true
  },
  worker: {
    // The demo's worker is a module worker, which uses top-level await.
    format: "es"
  }
});
