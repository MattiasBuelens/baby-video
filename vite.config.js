import { defineConfig } from "vite";

export default defineConfig({
  base: "/baby-video/",
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true,
  },
});
