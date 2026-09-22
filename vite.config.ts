import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { apiProxyPlugin } from "./vite-plugin-api-proxy";
import { previewHostPlugin } from "./src/features/chat/preview/host/vite-plugin-preview-host";

// https://vite.dev/config/
export default defineConfig({
  // previewHostPlugin serves previews from their own origin in dev; see
  // src/features/chat/preview/host/preview-host.ts for why that matters.
  plugins: [react(), tailwindcss(), apiProxyPlugin(), previewHostPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "es6-promise-pool": path.resolve(__dirname, "./src/lib/es6-promise-pool-esm.js"),
    },
  },
  optimizeDeps: {
    exclude: ["pyodide"],
  },
});
