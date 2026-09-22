// ============================================================
// Vite Plugin — /api/search In Development
// ============================================================
// `api/search.ts` is a Vercel edge function, so it does not exist under
// `vite dev` — which is where anyone testing this feature will be. Without
// this plugin the tool would answer "the endpoint did not answer" on every
// local run while working in production, the least useful way to fail.
//
// The handler itself is imported, not reimplemented: origin checks, provider
// dispatch, error mapping and throttling all live in
// src/features/chat/lib/search-endpoint.ts, shared with the edge function.
//
// The environment is re-read on every request, so adding TAVILY_API_KEY (or
// any other provider key) to `.env` takes effect on the NEXT search — no dev
// server restart. That is the whole point: put the key in, it works.
// ============================================================

import { loadEnv, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";

import { handleSearchRequest } from "./src/features/chat/lib/search-endpoint";

/** Origins allowed to reach the dev endpoint (localhost only) */
function isAllowedDevOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

/** Reads and parses a JSON request body, bounded */
function readJsonBody(req: IncomingMessage, maxBytes = 8 * 1024): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export function apiSearchPlugin(): Plugin {
  let devEnv: Record<string, string> = {};
  return {
    name: "vite-plugin-api-search",
    configResolved(config) {
      devEnv = loadEnv(config.mode, config.root, "");
    },
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith("/api/search")) return next();

        const origin = req.headers["origin"] as string | undefined;
        if (isAllowedDevOrigin(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED", error: "Method not allowed" }));
          return;
        }

        // Re-read .env per request: a key added while the server is running
        // is picked up by the next search instead of requiring a restart.
        const env = { ...devEnv, ...loadEnv("development", process.cwd(), ""), ...process.env };
        const body = (await readJsonBody(req)) as { query?: unknown; limit?: unknown } | null;

        const result = await handleSearchRequest(body?.query, body?.limit, {
          env,
          clientKey: "dev-local",
          origin: origin ?? null,
        });

        res.statusCode = result.status;
        res.end(JSON.stringify(result.body));
      });
    },
  };
}
