import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { apiProxyPlugin } from "./vite-plugin-api-proxy";
import { apiSearchPlugin } from "./vite-plugin-api-search";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), apiProxyPlugin(), apiSearchPlugin()],
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
