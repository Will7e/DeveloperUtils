import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
