import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * The production build goes to `ui/dist`, which the agent-console server
 * (`src/server/app.ts`) serves on 127.0.0.1. `npm run dev` is for working on
 * the interface alone: Vite serves it on loopback without the server's
 * `ac-served` mark, so `engine.ts` falls back to the fixture machine. The fixed
 * port only keeps the dev URL stable between runs.
 */
export default defineConfig({
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Served to a current desktop browser; no legacy transpilation needed.
    target: "es2022",
  },
});
