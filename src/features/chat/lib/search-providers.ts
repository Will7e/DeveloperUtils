// ============================================================
// Search Providers — One Table, Any Search Key
// ============================================================
// The agent needs to FIND pages, not only read a URL it was given. Search
// providers all sell the same thing and disagree on every detail: the verb
// (GET vs POST), where the credential goes (header, another header, body),
// the request field names, and the response shape. That variety is the
// reason this module exists — it is one descriptor per provider, so the
// question "which key did you get?" never becomes "which code path do we
// ship?".
//
// Adding the key is the whole configuration step. Whichever of the keys
// below is present, this picks it up; set SEARCH_PROVIDER to override when
// more than one is set.
//
// The parsing and request-building are PURE — a payload in, results out — so
// every provider's real response shape is pinned by a test rather than
// discovered in production when a key finally exists.
// ============================================================

// Relative, not the `@/` alias: this module is reached from api/search.ts,
// which the node tsconfig type-checks WITHOUT the alias mapping. Using the
// alias here type-checked in the app project and failed in the api one.
//
// Explicit .js, also for the api boundary: the whole graph is emitted as
// sibling .js files and resolved by Node there, where an extensionless
// specifier fails. Vite resolves `.js` to the `.ts` source, so this is the
// one spelling that works in both places.
import { validateUrlForSSRF } from "../../../utils/ssrfGuard.js";

import { decodeEntities, isBrowsableUrl } from "./web-page.js";

export type SearchProviderId = "tavily" | "brave" | "exa" | "serper";

export interface SearchResult {
  title: string;
  url: string;
  /** The provider's own excerpt — a lead, not the document */
  snippet: string;
}

/** One readable result, before it is trimmed and deduped */
const SNIPPET_MAX_CHARS = 400;
const TITLE_MAX_CHARS = 200;

// Limits live here, in the module both the server and the browser import, so
// the client cannot ask for more results than the endpoint will return.
/** Most results a single search returns */
export const SEARCH_MAX_LIMIT = 10;
/** Results per search when the caller does not say */
export const SEARCH_DEFAULT_LIMIT = 5;

export interface SearchProvider {
  id: SearchProviderId;
  label: string;
  /** Server-side environment variable holding the key */
  envVar: string;
  /** Where a key comes from */
  signupUrl: string;
  /** What the free tier is actually worth, for the "nothing configured" message */
  freeTier: string;
  method: "GET" | "POST";
  url: (query: string, limit: number) => string;
  headers: (apiKey: string) => Record<string, string>;
  /** JSON request body ("" for GET providers) */
  body: (query: string, limit: number) => string;
  /**
   * Results from this provider's response shape, order preserved.
   * Raw: trimming, cleaning and filtering are `normalizeResults`' job, so
   * every provider gets the same treatment instead of each doing its own.
   */
  parse: (payload: unknown) => SearchResult[];
}

/** Defensive field access — provider payloads are not ours to trust */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Plain text from a provider's excerpt or title.
 * Brave wraps matched terms in `<strong>` and every provider entity-encodes,
 * so raw values carry markup into context unless they are cleaned first.
 */
function cleanText(raw: string, maxChars: number): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** One result's excerpt, cleaned and capped */
export function cleanSnippet(raw: string): string {
  return cleanText(raw, SNIPPET_MAX_CHARS);
}

/**
 * Trims, drops unusable URLs and removes duplicates.
 *
 * The URL filter is the fetch tool's own rule, applied early: shape first
 * (`isBrowsableUrl`), then the SSRF guard. A result the agent cannot then
 * open is worse than a result it never saw, because it reads as an answer
 * and cannot be followed — and a result pointing at loopback or a metadata
 * endpoint is not one the model should be shown at all.
 */
export function normalizeResults(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const result of results) {
    const url = result.url.trim();
    if (!isBrowsableUrl(url)) continue;
    if (!validateUrlForSSRF(url, { allowLocalhost: false, allowPrivateSubnets: false }).allowed) continue;
    // Normalised key so the same page under two spellings collapses.
    const key = url.replace(/\/+$/, "").replace(/^https?:\/\//, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: cleanText(result.title, TITLE_MAX_CHARS) || url,
      url,
      snippet: cleanSnippet(result.snippet),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export const SEARCH_PROVIDERS: readonly SearchProvider[] = [
  {
    id: "tavily",
    label: "Tavily",
    envVar: "TAVILY_API_KEY",
    signupUrl: "https://tavily.com",
    freeTier: "1,000 searches/month free, no card",
    method: "POST",
    url: () => "https://api.tavily.com/search",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: (query, limit) =>
      JSON.stringify({
        query,
        max_results: limit,
        search_depth: "basic",
        // A provider-written answer is a second-hand claim about pages the
        // agent has not read. Results plus snippets, then fetch_url for the
        // document itself — the agent quotes what it actually read.
        include_answer: false,
        include_raw_content: false,
      }),
    parse: (payload) =>
      list(record(payload).results).map((raw) => {
        const r = record(raw);
        return { title: str(r.title), url: str(r.url), snippet: str(r.content) };
      }),
  },
  {
    id: "brave",
    label: "Brave Search",
    envVar: "BRAVE_API_KEY",
    signupUrl: "https://api-dashboard.search.brave.com",
    freeTier: "$5 of monthly credit (the free plan was retired in 2026)",
    method: "GET",
    url: (query, limit) =>
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    headers: (apiKey) => ({
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    }),
    body: () => "",
    parse: (payload) =>
      list(record(record(payload).web).results).map((raw) => {
        const r = record(raw);
        return { title: str(r.title), url: str(r.url), snippet: str(r.description) };
      }),
  },
  {
    id: "exa",
    label: "Exa",
    envVar: "EXA_API_KEY",
    signupUrl: "https://exa.ai",
    freeTier: "starter credit on signup",
    method: "POST",
    url: () => "https://api.exa.ai/search",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    }),
    body: (query, limit) =>
      JSON.stringify({
        query,
        numResults: limit,
        type: "auto",
        // Exa can return page text inline; asked for a short excerpt so the
        // result list stays a list and not a context dump.
        contents: { text: { maxCharacters: SNIPPET_MAX_CHARS } },
      }),
    parse: (payload) =>
      list(record(payload).results).map((raw) => {
        const r = record(raw);
        return { title: str(r.title), url: str(r.url), snippet: str(r.text) };
      }),
  },
  {
    id: "serper",
    label: "Serper",
    envVar: "SERPER_API_KEY",
    signupUrl: "https://serper.dev",
    freeTier: "2,500 one-time searches",
    method: "POST",
    url: () => "https://google.serper.dev/search",
    headers: (apiKey) => ({
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    }),
    body: (query, limit) => JSON.stringify({ q: query, num: limit }),
    parse: (payload) =>
      list(record(payload).organic).map((raw) => {
        const r = record(raw);
        return { title: str(r.title), url: str(r.link), snippet: str(r.snippet) };
      }),
  },
];

/**
 * The provider to use, given which keys exist.
 *
 * Order is by free-tier generosity at an agent's volume, because the first
 * usable key is almost always the only one a user sets: Tavily (1,000/month,
 * no card) → Brave → Exa → Serper. `SEARCH_PROVIDER` overrides it, which is
 * what you want when two keys are present and one is depleted.
 */
export function pickProvider(
  isConfigured: (envVar: string) => boolean,
  preferred?: string | null,
): SearchProvider | null {
  if (preferred) {
    const forced = SEARCH_PROVIDERS.find((p) => p.id === preferred.trim().toLowerCase());
    if (forced && isConfigured(forced.envVar)) return forced;
  }
  return SEARCH_PROVIDERS.find((p) => isConfigured(p.envVar)) ?? null;
}

/** The env var that switches providers when several keys are set */
export const SEARCH_PROVIDER_ENV = "SEARCH_PROVIDER";

/** Every env var that can enable search, for the "nothing configured" message */
export function searchEnvVars(): { envVar: string; label: string; freeTier: string; signupUrl: string }[] {
  return SEARCH_PROVIDERS.map((p) => ({
    envVar: p.envVar,
    label: p.label,
    freeTier: p.freeTier,
    signupUrl: p.signupUrl,
  }));
}
