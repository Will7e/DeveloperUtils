// ============================================================
// Preview Host Node Adapter — The Pure Host, On a Socket
// ============================================================
// ./preview-host.ts holds every decision (who may publish, what a served
// document's policy is, what a missing preview says). This file is only the
// part that needs a socket: read a request, hand it to the handler, write
// the response back, and — the piece that exists because a fixed port is
// not a guarantee — BIND SOMEWHERE ELSE IF THE PORT IS TAKEN.
//
// Two callers, one implementation, on purpose:
//
//   • ./preview-host-server.ts, for a host started by hand or on a machine
//     where the dev server cannot start it;
//   • ./vite-plugin-preview-host.ts, which runs the host INSIDE the Vite dev
//     server process so `npm run dev` is the only command anyone needs.
//
// They must not drift. When they were two implementations, the adapter
// answered every GET with 413 because "no body" and "body too large" were
// both `null`, and that bug existed in whichever copy ran and not in the
// other.
// ============================================================

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createPreviewHost,
  handlePreviewRequest,
  type PreviewHost,
  type PreviewHostOptions,
  type PreviewHostRequest,
  type PreviewHostResponse,
} from "./preview-host.ts";

export interface PreviewHostServerOptions extends Partial<PreviewHostOptions> {
  /** The first port to try */
  port: number;
  /**
   * How many consecutive ports to try. The dev server takes the next free
   * port when its usual one is busy, and so does this: a preview host that
   * cannot bind is a preview that silently falls back to the capability-
   * starved sandbox, for a reason nobody can see from the pane.
   */
  portAttempts?: number;
  /** Interface to bind. Loopback by default — this is not a public service. */
  bindHost?: string;
  /** Called for every handled request, for logging */
  onRequest?: (
    request: PreviewHostRequest,
    response: PreviewHostResponse,
    host: PreviewHost
  ) => void;
}

export interface RunningPreviewHost {
  /** What the app must be pointed at, e.g. `http://127.0.0.1:5174` */
  origin: string;
  port: number;
  host: PreviewHost;
  close(): Promise<void>;
}

const DEFAULT_PORT_ATTEMPTS = 12;
const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Reads a request body, refusing rather than buffering past the cap.
 *
 * A discriminated union, not a nullable string. Returning `null` for both
 * "no body" and "too large" is exactly how this adapter once answered every
 * GET with 413: a request with nothing to read looked identical to one that
 * had blown the cap, and the size check was then applied to a GET.
 *
 * Over the cap, the rest of the body is DRAINED rather than dropped. Cutting
 * the request short destroyed the socket before the 413 could be written, so
 * the publisher saw a connection reset instead of being told its document was
 * too large — a failure with no reason attached, which is the pattern this
 * whole feature keeps re-learning. Bytes past the cap are discarded, not
 * buffered, so the memory ceiling still holds.
 */
async function readBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; body: string } | { ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overCap = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      overCap = true;
      chunks.length = 0;
      continue;
    }
    if (!overCap) chunks.push(buf);
  }
  if (overCap) return { ok: false };
  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

/** One request, from socket to response */
function createListener(
  host: PreviewHost,
  onRequest: PreviewHostServerOptions["onRequest"]
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBytes = host.options.maxDocumentBytes;
  return (req, res) => {
    void (async () => {
      // Only methods that can carry a body are read at all: a GET has none,
      // and reading one would block until the client gives up.
      let body: string | null = null;
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const read = await readBody(req, maxBytes);
        if (!read.ok) {
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "Request body exceeded the size cap." }));
          return;
        }
        body = read.body;
      }

      // Header names lowercase here, once, so the handler never has to think
      // about casing — HTTP headers are case-insensitive, and a lookup that
      // forgets is a security check that silently returns undefined.
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }

      const request: PreviewHostRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        body,
      };

      const response = handlePreviewRequest(request, host);
      res.writeHead(response.status, response.headers);
      if (req.method === "HEAD") res.end();
      else res.end(response.body);

      onRequest?.(request, response, host);
    })().catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
  };
}

/** Binds one port. `false` means the port was busy, not that anything failed. */
function bind(server: Server, port: number, bindHost: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      // Busy is an answer, not an error: try the next port.
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(false);
      else reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });
}

/** The origin a bound port is reachable at (brackets for a bare IPv6 host) */
export function originFor(bindHost: string, port: number): string {
  const host = bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
  return `http://${host}:${port}`;
}

/**
 * Starts the host, on the first free port from `port` upwards.
 *
 * Throws only when every candidate port is busy — a single, nameable failure
 * that the caller can report, instead of a host that never came up.
 */
export async function startPreviewHostServer(
  options: PreviewHostServerOptions
): Promise<RunningPreviewHost> {
  const attempts = options.portAttempts ?? DEFAULT_PORT_ATTEMPTS;
  const bindHost = options.bindHost ?? DEFAULT_BIND_HOST;
  const host = createPreviewHost({
    allowedOrigins: options.allowedOrigins,
    maxDocumentBytes: options.maxDocumentBytes,
    maxPreviews: options.maxPreviews,
  });

  for (let i = 0; i < attempts; i++) {
    const port = options.port + i;
    const server = createServer(createListener(host, options.onRequest));
    let bound: boolean;
    try {
      bound = await bind(server, port, bindHost);
    } catch (err) {
      server.close();
      throw err;
    }
    if (!bound) {
      server.close();
      continue;
    }
    return {
      origin: originFor(bindHost, port),
      port,
      host,
      close: () =>
        new Promise<void>((resolve) => {
          // Keep-alive connections would otherwise hold the port open until
          // the browser decides to close them, which is exactly the window in
          // which a restarted dev server fails to bind its own host.
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  throw new Error(
    `No free port in ${options.port}–${options.port + attempts - 1}: every candidate is in use.`
  );
}
