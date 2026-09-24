import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { apiProxyPlugin } from "./vite-plugin-api-proxy";
import { apiSearchPlugin } from "./vite-plugin-api-search";
import { isolationHeaders } from "./src/features/chat/container/isolation";

// https://vite.dev/config/
//
// The isolation headers are served here as well as in `vercel.json`, and they
// come from the same module so the two cannot say different things. They are not
// ceremony: the browser workspace tier boots a cross-origin runtime iframe that
// needs `SharedArrayBuffer`, which a document only gets when it is cross-origin
// isolated. Without them here, the tier works on the deployed site and fails on
// localhost, which reads as a bug in the tier.
//
// `preview` is included deliberately: it serves the real build, so it is the one
// place a header mistake can be caught before a deploy without pushing a branch.
export default defineConfig({
  plugins: [react(), tailwindcss(), apiProxyPlugin(), apiSearchPlugin()],
  server: {
    headers: isolationHeaders(),
  },
  preview: {
    headers: isolationHeaders(),
  },
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
