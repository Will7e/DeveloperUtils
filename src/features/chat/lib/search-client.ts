// ============================================================
// Web Search Client — Talking To /api/search
// ============================================================
// The browser side. The key is never here; it lives in the deployment's
// environment (or the dev server's .env) and this only sees results.
//
// The failure that matters most is the unconfigured one. "Search is broken"
// is useless to a user who has done nothing wrong — nothing is broken, no
// key is set — so that case is reported as the exact setup step: which
// environment variables enable it, what each free tier is worth, and the
// one thing that must not be done (prefixing it with VITE_, which would
// ship the key to the browser).
// ============================================================

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  type SearchResult,
} from "./search-providers";

const SEARCH_ENDPOINT = "/api/search";

export interface SearchSuccess {
  ok: true;
  provider: string;
  query: string;
  results: SearchResult[];
}

/**
 * Availability is LEARNED here, not assumed (lib/availability.ts).
 *
 * A search that just failed because no provider is configured is the most
 * reliable probe there is, and the next turn's note can then tell the model the
 * consequence before it wastes a round discovering it: ask for the URL instead
 * of inventing one. A search that worked says the opposite.
 */
import { noteCapability } from "./availability";

export interface SearchFailure {
  ok: false;
  error: string;
  /** True when the reason is "no key is configured", which needs a human */
  setupRequired: boolean;
}

export type SearchOutcome = SearchSuccess | SearchFailure;

interface SearchEndpointBody {
  provider?: string;
  query?: string;
  results?: SearchResult[];
  code?: string;
  error?: string;
  hint?: string;
  providers?: { envVar: string; label: string; freeTier: string; signupUrl: string }[];
}

/** The setup step, spelled out — the one message a user actually acts on */
function setupMessage(body: SearchEndpointBody): string {
  const choices = body.providers ?? [];
  if (!choices.length) {
    return "Web search is not configured on this deployment, and no provider list was returned.";
  }
  const lines = choices.map((p) => `  • ${p.envVar} — ${p.label}, ${p.freeTier} (${p.signupUrl})`);
  return [
    "Web search needs an API key before it can be used. Nothing is broken — no provider is configured.",
    "Set ONE of these as a server-side environment variable:",
    ...lines,
    "Use .env for local development (it is picked up by the next search, no restart needed) or the project's environment variables on Vercel for a deployment.",
    "Do NOT prefix it with VITE_ — that ships the key to the browser.",
  ].join("\n");
}

/**
 * Runs one web search. Never throws: a failed search is a stated reason, so
 * the model can tell "nothing matched" from "search is unavailable" — the
 * difference between asking the user for a URL and inventing one.
 */
export async function searchWeb(
  query: string,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<SearchOutcome> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "No search query given.", setupRequired: false };

  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? SEARCH_DEFAULT_LIMIT)),
    SEARCH_MAX_LIMIT,
  );

  let res: Response;
  try {
    res = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: trimmed, limit }),
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) return { ok: false, error: "Aborted by the user.", setupRequired: false };
    // No route at all is an OBSERVED fact about this environment, not a
    // transient failure: the endpoint runs on the deployed app and (locally)
    // only while the dev server that serves /api/search is up. Recording it
    // lets the next turn's note say the one thing that stops a hallucinated
    // URL — "ask the user instead" — rather than staying silent while the
    // agent tries again.
    noteCapability("webSearch", "down");
    return {
      ok: false,
      error:
        `The search endpoint did not answer (${err instanceof Error ? err.message : String(err)}). ` +
        "It is a server function: it runs on the deployed app, and locally only while the Vite dev server (which serves /api/search) is running.",
      setupRequired: false,
    };
  }

  let body: SearchEndpointBody;
  try {
    body = (await res.json()) as SearchEndpointBody;
  } catch {
    // A dev server that has no such route answers with the SPA's HTML.
    noteCapability("webSearch", "down");
    return {
      ok: false,
      error: `The search endpoint returned a non-JSON response (HTTP ${res.status}), so it is probably not wired up in this environment.`,
      setupRequired: false,
    };
  }

  if (res.status === 503 && body.code === "SEARCH_NOT_CONFIGURED") {
    noteCapability("webSearch", "down");
    return { ok: false, error: setupMessage(body), setupRequired: true };
  }

  if (res.status === 403 && body.code === "FORBIDDEN_ORIGIN") {
    // Same class of fact as the two above: the endpoint answered, and it will
    // answer the same way for the rest of this session, so a retry costs a
    // round. The cause is deployment-side (who the caller appears to be), never
    // the key — which is exactly why it must not be reported as "not
    // configured".
    noteCapability("webSearch", "down");
    return {
      ok: false,
      error:
        `${body.error ?? "Search was refused for this origin."} The provider key is not the problem — ` +
        "this is the request's origin, so say you cannot reach the web here and ask for the URL instead of inventing one.",
      setupRequired: false,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: body.error
        ? `Search failed (HTTP ${res.status}): ${body.error}`
        : `Search failed with HTTP ${res.status}.`,
      setupRequired: false,
    };
  }

  noteCapability("webSearch", "up");
  return {
    ok: true,
    provider: body.provider ?? "unknown",
    query: body.query ?? trimmed,
    results: Array.isArray(body.results) ? body.results : [],
  };
}
