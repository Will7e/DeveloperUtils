// ============================================================
// Search Edge Function — The Agent's Web Search
// ============================================================
// POST /api/search  { query: string, limit?: number }
// → { provider, query, results: [{ title, url, snippet }] }
//
// Exists for one reason: a search API key is a secret, and a browser cannot
// hold one. The key lives here, in the deployment's environment, and the
// client only ever sees results.
//
// Set ONE of these (server-side, never with a VITE_ prefix):
//
//   TAVILY_API_KEY   1,000 searches/month free, no card
//   BRAVE_API_KEY    $5 of monthly credit
//   EXA_API_KEY      starter credit
//   SERPER_API_KEY   2,500 one-time searches
//
// With more than one set, SEARCH_PROVIDER pins which one is used. Nothing
// else needs configuring: the key's presence is what enables the tool.
//
// The whole handler lives in lib/search-endpoint.ts, shared with the dev
// server's plugin, so this file only adapts a Request to it.
// ============================================================

// Explicit .js, like api/proxy.ts and api/github.ts: the deployed bundle is
// emitted as sibling .js files, so an extensionless specifier here resolves
// under Vite and fails only in production.
import { handleSearchRequest } from "../src/features/chat/lib/search-endpoint.js";

export const config = {
  runtime: "edge",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Best-effort client identity for throttling (edge sets this header) */
function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ code: "METHOD_NOT_ALLOWED", error: "Method not allowed" }, 405);
  }

  let body: { query?: unknown; limit?: unknown };
  try {
    body = (await req.json()) as { query?: unknown; limit?: unknown };
  } catch {
    return json({ code: "BAD_REQUEST", error: "Invalid JSON body" }, 400);
  }

  // `process.env` is the supported interface on the edge runtime;
  // `import.meta.env` is a Vite construct that is never populated here.
  const result = await handleSearchRequest(body.query, body.limit, {
    env: process.env,
    clientKey: clientKey(req),
    origin: req.headers.get("origin"),
    // The host this request arrived on, so a same-origin call is recognised
    // on any domain the app is deployed to (lib/search-endpoint.ts).
    host: req.headers.get("host"),
  });

  return json(result.body, result.status);
}
