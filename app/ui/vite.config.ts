import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const uiRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Relative asset URLs are required when the packaged privileged scheme
  // serves the renderer outside a normal HTTP origin.
  base: "./",
  root: uiRoot,
  build: {
    emptyOutDir: true,
    outDir: "dist",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
