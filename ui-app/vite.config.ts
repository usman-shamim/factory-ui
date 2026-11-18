import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// `npm run bridge` serves this. The dev server proxies it onto the app's own
// origin, so the app keeps its existing relative /api and /ws paths and no CORS
// enters the request path.
const BRIDGE_TARGET = "http://127.0.0.1:8787";

export default defineConfig(({ command }) => {
  // A Pages value pasted as a markdown autolink keeps its brackets and the app
  // then calls an unreachable host, so fail loudly at build time instead.
  // `npm run dev` is same-origin through the proxy and needs no URL.
  const bridgeUrl = process.env.VITE_BRIDGE_URL ?? "";
  if (command === "build" && !/^https?:\/\//.test(bridgeUrl)) {
    throw new Error(
      `VITE_BRIDGE_URL must be a bare URL beginning with http(s):// — got ${JSON.stringify(bridgeUrl)}`,
    );
  }

  return {
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
    server: {
      port: 5173,
      proxy: {
        "/api": { target: BRIDGE_TARGET, changeOrigin: false },
        "/healthz": { target: BRIDGE_TARGET, changeOrigin: false },
        "/ws": { target: BRIDGE_TARGET.replace(/^http/, "ws"), ws: true },
      },
    },
  };
});
