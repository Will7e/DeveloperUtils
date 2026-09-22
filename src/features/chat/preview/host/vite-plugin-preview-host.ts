// ============================================================
// Preview Host Plugin — The Host, Started BY `npm run dev`
// ============================================================
// The host is what gives a preview an origin of its own, and a preview that
// cannot get one is a preview whose router has no path to match, whose
// storage resets on every rebuild, and whose status is a black frame. So it
// must not be a second command somebody has to remember.
//
// It used to `spawn` a child process. That works — until it doesn't, and
// every way it fails is invisible from the pane: the child needs a Node
// that strips TypeScript, needs port 5174 to be free, and outlives the dev
// server if the exit handlers are missed. All three produce the same
// symptom — "No preview host answered" — with nothing to show for it.
//
// So the host runs INSIDE the Vite process now:
//
//   • it dies exactly when the dev server does, and restarts with it;
//   • it walks upward from 5174 if that port is busy, so the app having
//     taken the port cannot lock the preview out of its own host;
//   • and the port it actually got is published to the app on the APP's own
//     origin (`GET /__preview-host`), because the app must never have to
//     guess a port, and a guess that is wrong is a silent fallback.
//
// Dev only (`apply: "serve"`). A deployed build is served from a real domain
// and needs a hosted origin named by `VITE_PREVIEW_ORIGIN` — see
// ./preview-host.ts for what that has to be, and ./preview-host-client.ts
// for how the app decides which of the two it is talking to.
// ============================================================

import type { Plugin, ViteDevServer } from "vite";
import { startPreviewHostServer, type RunningPreviewHost } from "./preview-host-node.ts";
// From ./preview-host, deliberately: importing the browser client here would
// pull a module that reads `import.meta.env` into the Node tsconfig project.
import { PREVIEW_HOST_DISCOVERY_PATH } from "./preview-host.ts";

/** The port to try first; the adapter walks upward from here */
const FIRST_PORT = 5174;

/**
 * Module scope, not closure scope: a Vite config change restarts the server
 * and re-runs `configureServer` in the SAME process, so the previous
 * listener has to be findable and closed — otherwise the restart fails to
 * bind and the preview quietly loses its origin for the rest of the day.
 */
let running: RunningPreviewHost | null = null;
/** What the discovery endpoint answers. Recorded even on failure, with why. */
let discovery: { origin: string | null; error: string | null } = {
  origin: null,
  error: "The preview host has not started yet.",
};

async function stopHost(): Promise<void> {
  const current = running;
  running = null;
  if (current) await current.close();
}

/**
 * Origins that may publish a preview.
 *
 * The app's own origins, taken from the dev server rather than assumed:
 * `--host` or a busy port changes the origin the browser uses, and an
 * allowlist that does not follow it turns into a 403 that reads exactly like
 * a missing host. (Any loopback origin is allowed by the host itself too —
 * see `isAllowedPublisher`.)
 */
function publishOrigins(server: ViteDevServer): string[] {
  const urls = server.resolvedUrls;
  const origins = [...(urls?.local ?? []), ...(urls?.network ?? [])].map((url) => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  });
  return [...new Set(origins.filter(Boolean))];
}

export function previewHostPlugin(): Plugin {
  return {
    name: "intab-preview-host",
    apply: "serve",

    async configureServer(server) {
      const port = Number(process.env.PREVIEW_HOST_PORT ?? FIRST_PORT);

      // Registered BEFORE the host starts: a discovery endpoint that only
      // answers when everything worked cannot report why nothing did.
      server.middlewares.use(PREVIEW_HOST_DISCOVERY_PATH, (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(discovery));
      });

      await stopHost();
      try {
        running = await startPreviewHostServer({
          port,
          allowedOrigins: publishOrigins(server),
          onRequest: (request, response, host) => {
            if (!request.path.startsWith("/publish")) return;
            const ok = response.status === 200;
            server.config.logger.info(
              `preview ${ok ? "published" : `refused (${response.status})`} from ` +
                `${request.headers.origin ?? "no origin"} — ${host.previews.size} live`
            );
          },
        });
        discovery = { origin: running.origin, error: null };
        server.config.logger.info(
          `\n  preview host listening on ${running.origin}\n` +
            "  previews are served from their own origin: storage, cookies,\n" +
            "  Web Locks and the app's router work, and the preview cannot\n" +
            "  reach this app's storage\n"
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        discovery = { origin: null, error: message };
        server.config.logger.warn(
          `\n  preview host could not start: ${message}\n` +
            "  previews will run as inline sandboxed documents (no routing,\n" +
            "  in-memory storage) until it can: set PREVIEW_HOST_PORT to a free\n" +
            "  port, or run it by hand —\n" +
            "    node src/features/chat/preview/host/preview-host-server.ts\n"
        );
      }

      server.httpServer?.once("close", () => {
        void stopHost();
      });
    },
  };
}
