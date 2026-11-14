import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: appRoot,
  plugins: [react()],
  // The theme CSS is imported by main.tsx, so nothing needs copying. Leaving
  // publicDir on would publish all 26 .tsx sources under code-examples/.
  publicDir: false,
  build: {
    outDir: `${repoRoot}dist-app`,
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
});
