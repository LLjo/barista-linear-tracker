import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  base: "./",
  build: {
    outDir: "dist",
  },
  server: {
    port: 0, // auto-assign in dev
  },
});
