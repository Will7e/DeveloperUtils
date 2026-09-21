import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest 5's default threads pool hangs under this app's Vite 8
    // setup; forks run reliably and fast (whole suite < 2s).
    // Isolation ON: per-file vi.mock + module caches (model catalog)
    // leak across files when one fork is reused without isolation.
    pool: "forks",
    isolate: true,
    noFileParallelism: true,
    server: {
      deps: {
        // `@/...` imports look like npm scoped packages to Node, so
        // Vite SSR externalizes them BEFORE the alias resolves — the
        // forks pool then fails with "Cannot find package '@/...'".
        // Inlining forces Vite to transform them with the alias.
        inline: [/@\//],
      },
    },
  },
});
