// ============================================================
// Search Endpoint — SERVER-ONLY Handler
// ============================================================
// One implementation of "search the web", used by two entry points:
//
//   • api/search.ts          — the Vercel edge function (production)
//   • vite-plugin-api-search — the dev server's equivalent
//
// They differ only in how they are wired to a request, which keeps the
// interesting parts — provider dispatch, error mapping, rate limiting and
// key redaction — in one place instead of two that drift.
//
// It is SERVER-ONLY: the API key is read here and never leaves. Nothing in
// the browser bundle may import this file. (Same arrangement as api/search.ts,
// which the dev plugin and the deployed function share.)
//
// The contract with the client is small on purpose:
//
//   POST { query, limit? }  →
//     200 { provider, query, results[] }
//     400 BAD_REQUEST | 403 FORBIDDEN_ORIGIN | 429 RATE_LIMITED
//     502 SEARCH_PROVIDER_ERROR | 503 SEARCH_NOT_CONFIGURED
//
// 503 is the important one. "No key is set" is not an error the user can
// debug from a stack trace, so it comes back as a structured setup step
// naming every env var that would enable search and where each key comes
// from — which is what makes adding a key the only step required.
// ============================================================

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_PROVIDER_ENV,
  normalizeResults,
  pickProvider,
  searchEnvVars,
  // Explicit .js: reached from api/search.ts, whose whole graph is emitted
  // as .js and resolved by Node, where an extensionless specifier fails.
} from "./search-providers.js";

/** Provider calls allowed per client per window (per instance, best-effort) */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
/** A search that has not answered in this long is not worth the wait */
const PROVIDER_TIMEOUT_MS = 12_000;

export interface SearchEndpointBody {
  provider?: string;
  query?: string;
  results?: { title: string; url: string; snippet: string }[];
  /** Present on failures; a code the client can branch on */
  code?: string;
  error?: string;
  /** Present on 503: what to set, and where to get it */
  providers?: { envVar: string; label: string; freeTier: string; signupUrl: string }[];
  hint?: string;
}

export interface SearchEndpointResponse {
  status: number;
  body: SearchEndpointBody;
}

export interface SearchEndpointDeps {
  /** Server environment: process.env in both callers */
  env: Record<string, string | undefined>;
  /** Per-caller throttle key (client IP, or "dev" locally) */
  clientKey: string;
  /** Caller Origin, checked against the allowlist */
  origin?: string | null;
  /**
   * The Host the request arrived on (its own origin), used to recognise a
   * same-origin call. Without it the allowlist can only name the domains
   * written into this file, so an app deployed on any other domain answers
   * 403 to itself — with the provider key correctly configured, which is why
   * that failure reads as "search is broken".
   */
  host?: string | null;
  /** Injectable for tests */
  fetchImpl?: typeof fetch;
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Best-effort fixed-window throttle (per instance, not global) */
function withinRateLimit(key: string): boolean {
  const now = Date.now();
  if (rateBuckets.size > 5_000) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt <= now) rateBuckets.delete(k);
    }
    if (rateBuckets.size > 5_000) rateBuckets.clear();
  }
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

/** Exposed so a test can start from a clean window */
export function resetSearchRateLimit(): void {
  rateBuckets.clear();
}

/**
 * The hostname of an Origin or Host value, lowercased and port-free.
 * "" when the value is absent or unparseable, so a missing header can never
 * be mistaken for a match.
 */
function hostnameOf(value: string | null | undefined): string {
  if (!value || !value.trim()) return "";
  const raw = value.trim();
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Origins allowed to call this endpoint. It is POST-only and same-origin
 * from the app, so an allowlist costs nothing and stops a third-party page
 * from spending the user's search quota.
 *
 * SAME-ORIGIN IS CHECKED FIRST, against the Host the request actually
 * arrived on. That is the load-bearing test, because "the app calls itself"
 * is the whole contract — and a hard-coded domain list only happens to
 * express it for the two names the vendor deploys to. Any other domain (a
 * custom production domain, a self-hosted copy, a preview alias) made the
 * app's own search 403 while the provider key was fine, which is the most
 * confusing possible shape of "search does not work".
 */
export function isAllowedSearchOrigin(
  origin: string | null | undefined,
  env: Record<string, string | undefined>,
  requestHost?: string | null,
): boolean {
  if (!origin) return true; // Non-browser client (no Origin header)
  try {
    const host = new URL(origin).hostname.toLowerCase();
    const ownHost = hostnameOf(requestHost).replace(/^www\./, "");
    if (ownHost && host.replace(/^www\./, "") === ownHost) return true;
    const vercelHosts = [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.replace(/^www\./, "").toLowerCase());
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localhost") ||
      host === "in-tab.se" ||
      host.endsWith(".in-tab.se") ||
      host === "intab.dev" ||
      host.endsWith(".intab.dev") ||
      vercelHosts.some((v) => host === v || host.endsWith(`.${v}`))
    );
  } catch {
    return false;
  }
}

/**
 * Any occurrence of the key is removed from text on its way out.
 *
 * A provider that echoes the credential in an error message would otherwise
 * put it in a log, a tool result and the model's context, all at once.
 */
function redact(text: string, secret: string | undefined): string {
  if (!secret || !text.includes(secret)) return text;
  return text.split(secret).join("***");
}

/** The one body every "you have not configured this yet" path returns */
function notConfigured(): SearchEndpointResponse {
  return {
    status: 503,
    body: {
      code: "SEARCH_NOT_CONFIGURED",
      error: "Web search is not configured on this deployment.",
      providers: searchEnvVars(),
      hint:
        `Set ONE of these as a server-side environment variable and search works with no other change: ` +
        `${searchEnvVars()
          .map((p) => `${p.envVar} (${p.label} — ${p.freeTier})`)
          .join(", ")}. ` +
        `They must NOT be prefixed with VITE_, which would ship the key to the browser. ` +
        `With more than one key set, ${SEARCH_PROVIDER_ENV} chooses between them.`,
    },
  };
}

/**
 * Runs one search. Never throws: every failure is a status plus a reason the
 * caller can act on.
 */
export async function handleSearchRequest(
  rawQuery: unknown,
  rawLimit: unknown,
  deps: SearchEndpointDeps,
): Promise<SearchEndpointResponse> {
  if (!isAllowedSearchOrigin(deps.origin, deps.env, deps.host)) {
    return {
      status: 403,
      body: {
        code: "FORBIDDEN_ORIGIN",
        // Stated as what it is, because it is NOT a configuration problem the
        // user can fix by adding a key: the call reached the endpoint and was
        // refused for WHO sent it.
        error:
          "This origin may not use the search endpoint. It accepts same-origin calls from the app itself only, so a request from another page (or a proxy that rewrote Origin) is refused.",
      },
    };
  }

  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!query) {
    return { status: 400, body: { code: "BAD_REQUEST", error: "Missing 'query'." } };
  }
  if (query.length > 500) {
    return { status: 400, body: { code: "BAD_REQUEST", error: "Query is too long (500 characters max)." } };
  }

  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), SEARCH_MAX_LIMIT)
      : SEARCH_DEFAULT_LIMIT;

  const provider = pickProvider((envVar) => Boolean(deps.env[envVar]), deps.env[SEARCH_PROVIDER_ENV]);
  if (!provider) return notConfigured();

  const apiKey = deps.env[provider.envVar] as string;
  if (!withinRateLimit(deps.clientKey)) {
    return {
      status: 429,
      body: {
        code: "RATE_LIMITED",
        error: `Too many searches from this client (${RATE_LIMIT_MAX_REQUESTS} per minute).`,
      },
    };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const res = await doFetch(provider.url(query, limit), {
      method: provider.method,
      headers: provider.headers(apiKey),
      ...(provider.method === "POST" ? { body: provider.body(query, limit) } : {}),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: 502,
        body: {
          code: "SEARCH_PROVIDER_ERROR",
          provider: provider.id,
          // The provider's own words, redacted: "401 Unauthorized" and
          // "quota exceeded" are different fixes for the user.
          error: redact(text.slice(0, 400), apiKey) || `The search provider answered ${res.status}.`,
        },
      };
    }

    const payload: unknown = await res.json().catch(() => null);
    const results = normalizeResults(provider.parse(payload), limit);
    return { status: 200, body: { provider: provider.id, query, results } };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      status: 502,
      body: {
        code: "SEARCH_PROVIDER_ERROR",
        provider: provider.id,
        error: aborted
          ? `The search provider did not answer within ${PROVIDER_TIMEOUT_MS / 1000}s.`
          : redact(err instanceof Error ? err.message : String(err), apiKey),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
