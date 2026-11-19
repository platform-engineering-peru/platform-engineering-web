import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: "src/web",
  base: "/",
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: {
      allow: [
        fileURLToPath(new URL("./src", import.meta.url)),
        fileURLToPath(new URL("./public", import.meta.url)),
      ],
    },
  },
});
