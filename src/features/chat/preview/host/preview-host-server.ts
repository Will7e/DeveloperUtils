// ============================================================
// Preview Host Server — the local origin, as a standalone process
// ============================================================
//   node src/features/chat/preview/host/preview-host-server.ts
//
// The socket work lives in ./preview-host-node.ts and the decisions live in
// ./preview-host.ts; what is left here is the part a process owns: reading
// the environment, printing what it did, and exiting cleanly.
//
// You normally do not need this command: `npm run dev` starts the host
// INSIDE the Vite process (see ./vite-plugin-preview-host.ts). This exists
// for the cases where that cannot happen — a host on another port, a dev
// server started before the plugin existed, a headless setup.
//
// Environment:
//   PREVIEW_HOST_PORT      first port to try (default 5174; it walks upward
//                          if that one is taken)
//   PREVIEW_HOST_ORIGINS   comma-separated origins allowed to publish
//                          (default: the Vite dev origins on 5173; any
//                          loopback origin is always allowed)
//   PREVIEW_HOST_MAX_BYTES document size cap (default 8 MiB)
// ============================================================

import { startPreviewHostServer } from "./preview-host-node.ts";

const port = Number(process.env.PREVIEW_HOST_PORT ?? 5174);
const allowedOrigins = (process.env.PREVIEW_HOST_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const maxDocumentBytes = Number(process.env.PREVIEW_HOST_MAX_BYTES ?? 8 * 1024 * 1024);

let running: Awaited<ReturnType<typeof startPreviewHostServer>> | null = null;

try {
  running = await startPreviewHostServer({
    port,
    allowedOrigins,
    maxDocumentBytes,
    onRequest: (request, response, host) => {
      if (!request.path.startsWith("/publish")) return;
      const ok = response.status === 200;
      console.log(
        `${ok ? "published" : `refused (${response.status})`} ${request.method} ${request.path} ` +
          `from ${request.headers.origin ?? "no origin"} — ${host.previews.size} live`
      );
    },
  });
} catch (err) {
  console.error(
    `\n  The preview host could not start: ${err instanceof Error ? err.message : String(err)}\n` +
      "  Pick another port:  PREVIEW_HOST_PORT=5274 node src/features/chat/preview/host/preview-host-server.ts\n" +
      "  …and point the app at it:  VITE_PREVIEW_ORIGIN=http://127.0.0.1:5274 npm run dev\n"
  );
  process.exit(1);
}

console.log(
  [
    "",
    `  Preview host listening on ${running.origin}`,
    `  May publish: ${allowedOrigins.join(", ")}, plus any loopback origin`,
    "",
    "  Every preview served from here has its own origin, so it is a secure",
    "  context: localStorage, cookies, IndexedDB, Web Locks and service",
    "  workers all work, and the preview can reach none of the app's storage.",
    "",
    "  Point the app at it (or leave it unset in dev — 5174 is the default):",
    `    VITE_PREVIEW_ORIGIN=${running.origin} npm run dev`,
    "",
  ].join("\n")
);

const shutdown = () => {
  void running?.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
