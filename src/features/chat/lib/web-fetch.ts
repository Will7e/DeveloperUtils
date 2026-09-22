// ============================================================
// Web Fetch — Reading A Public Page From The Browser
// ============================================================
// The transport for fetch_url, and the reason it needs one.
//
// A browser cannot simply GET an arbitrary public page: CORS means the
// remote server decides whether a script may read its response, and most
// servers say no. So there are two paths, tried in order:
//
//   1. a direct fetch — works for the minority of hosts that send
//      Access-Control-Allow-Origin, and it is the only path that can see a
//      redirect chain or a final URL; then
//   2. the app's own /api/proxy relay, which runs the same SSRF guard as
//      api/proxy.ts and the Vite dev plugin, and which adds the CORS
//      headers the browser needs to let this origin read the bytes.
//
// Both paths check the URL against utils/ssrfGuard BEFORE the request, in
// this process, so a model that has been talked into fetching
// 169.254.169.254 is refused by shape rather than by luck. The proxy checks
// again server-side, because a redirect can move the target after this
// check has already passed — that is the half this side cannot see.
// ============================================================

import { validateUrlForSSRF } from "@/utils/ssrfGuard";

import { WEB_MAX_BODY_BYTES, describeRedirect, isBrowsableUrl } from "./web-page";

/** Same relay the GitHub client falls back to */
const PROXY_PREFIX = "/api/proxy?url=";

/** Enough to identify a document without pulling the whole thing */
const PROBE_BYTES = 2048;

export interface WebFetchSuccess {
  ok: true;
  /** The URL as requested */
  requestedUrl: string;
  /** Where the content actually came from, when that is knowable */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  /** True when the relay was needed because CORS refused the direct fetch */
  viaProxy: boolean;
  /** Stated when a redirect moved the target (direct path only) */
  redirectNote: string | null;
  /** True when the body hit the byte cap and was cut */
  bodyTruncated: boolean;
}

export interface WebFetchFailure {
  ok: false;
  error: string;
}

export type WebFetchResult = WebFetchSuccess | WebFetchFailure;

/**
 * The app's own shell, served by a dev server's SPA fallback.
 *
 * Worth detecting precisely because it would otherwise look like a
 * successful read: a 200, HTML, a <title>. An agent handed the product's own
 * index.html as "the page you asked for" would reason about it as if it were
 * the documentation it wanted.
 */
function looksLikeAppShell(body: string): boolean {
  return body.includes("@vite/client") || body.includes("/src/main.tsx");
}

/**
 * Reads at most `cap` bytes, and reports whether it had to stop.
 *
 * A response is streamed rather than buffered so an unexpectedly large
 * document costs bounded memory — and so the cut is a fact in the result
 * rather than a silent truncation the model never hears about.
 */
async function readCapped(res: Response, cap: number): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.length > cap
      ? { body: text.slice(0, cap), truncated: true }
      : { body: text, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (size + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - size));
      size = cap;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // A cut mid-codepoint decodes to a replacement character; truncation is
  // reported either way, so the cost of the cut is already stated.
  return { body: new TextDecoder("utf-8").decode(merged), truncated };
}

/** One attempt. Throws when no response arrives at all — a CORS refusal looks like this. */
async function attemptFetch(url: string, signal: AbortSignal | undefined): Promise<Response> {
  return fetch(url, {
    method: "GET",
    redirect: "follow",
    signal,
    headers: { Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" },
  });
}

type Attempt =
  | { ok: true; res: Response; body: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * An attempt that reports its own failure instead of throwing.
 *
 * A thrown error is the one shape the caller cannot hand to the model, so
 * the failure is converted here, once, and named where it happened.
 */
async function tryAttempt(url: string, signal: AbortSignal | undefined, cap: number): Promise<Attempt> {
  try {
    const res = await attemptFetch(url, signal);
    const { body, truncated } = await readCapped(res, cap);
    return { ok: true, res, body, truncated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetches a public document and returns its bytes plus what the caller needs
 * to describe them honestly.
 *
 * Never throws: every failure comes back as a stated reason, because the
 * model has to be able to tell "the page says X" from "I could not read the
 * page", and a thrown error is the one shape it does not get to reason about.
 */
export async function fetchWebDocument(
  rawUrl: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<WebFetchResult> {
  const url = rawUrl.trim();
  const cap = options.maxBytes ?? WEB_MAX_BODY_BYTES;

  if (!url) return { ok: false, error: "No URL given." };
  if (!isBrowsableUrl(url)) {
    return {
      ok: false,
      error: `'${url}' is not an http(s) URL. Only public web documents can be read; other schemes (data:, file:, javascript:) are refused.`,
    };
  }

  // Same guard the relay runs. Refusing here means the request is never
  // made, so a metadata endpoint or a loopback service is not even probed.
  const guard = validateUrlForSSRF(url, { allowLocalhost: false, allowPrivateSubnets: false });
  if (!guard.allowed) {
    return { ok: false, error: `Refused: ${guard.reason}. Only public internet hosts can be read.` };
  }

  const direct = await tryAttempt(url, options.signal, cap);
  if (options.signal?.aborted) return { ok: false, error: "Aborted by the user." };
  if (direct.ok) {
    const { res } = direct;
    return {
      ok: true,
      requestedUrl: url,
      finalUrl: res.url || url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: direct.body,
      viaProxy: false,
      redirectNote: describeRedirect(url, res.url || url),
      bodyTruncated: direct.truncated,
    };
  }

  // The relay. Its own SSRF check runs server-side, after any redirect.
  const proxy = await tryAttempt(`${PROXY_PREFIX}${encodeURIComponent(url)}`, options.signal, cap);
  if (options.signal?.aborted) return { ok: false, error: "Aborted by the user." };
  if (!proxy.ok) {
    return {
      ok: false,
      error: `Could not read ${url}. The direct request failed (${direct.error}) and the relay failed too (${proxy.error}).`,
    };
  }

  const { res } = proxy;
  if (!res.headers.get("access-control-allow-origin") && looksLikeAppShell(proxy.body.slice(0, PROBE_BYTES))) {
    return {
      ok: false,
      error:
        "The API relay did not answer — this is the app's own page, not the requested document. The relay runs on the deployed app and in the dev server as a Vite plugin; if it is missing, restart the dev server.",
    };
  }

  return {
    ok: true,
    requestedUrl: url,
    // The relay does not report the upstream URL, so the requested URL is the
    // only honest answer here — stated rather than guessed.
    finalUrl: url,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: proxy.body,
    viaProxy: true,
    // A refusal to explain is not an error: CORS making the relay necessary is
    // the ordinary case, and a redirect through the relay is invisible here.
    redirectNote: null,
    bodyTruncated: proxy.truncated,
  };
}
