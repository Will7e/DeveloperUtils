// ============================================================
// Preview Host Client — Publishing a Build to a Real Origin
// ============================================================
// The app side of ./preview-host.ts. A build is published to the host, and
// the frame is then pointed at the returned URL instead of receiving the
// document through `srcdoc`.
//
// The difference is not cosmetic. `srcdoc` inside a sandboxed frame is an
// opaque origin: not a secure context, storage denied, and a shim installed
// per capability as each one is missed. A published document is a normal
// page on `http://127.0.0.1:<port>` — a distinct origin from the app, so it
// is still isolated, and a secure one, so the browser grants the APIs
// instead of us impersonating them.
//
// Two rules this module exists to keep in one place:
//
//   • WHICH origins count as hosted. `blob:` is the old delivery path, and
//     it must never be mistaken for a host: a blob document inherits the
//     APP's origin, so it shares the app's storage — the fallback is less
//     isolated than the sandbox it replaced, and it is only ever used when
//     no host answers.
//   • WHEN to stop trying. The probe runs once per session per origin. A
//     developer who has not started the host must not pay a connection
//     attempt on every rebuild, and must be TOLD once, in the preview
//     console, why state is resetting instead of having to infer it.
//
//   • WHICH port. Nothing here guesses. The dev server knows which port its
//     host got (`GET /__preview-host`, same-origin), because the host walks
//     upward when 5174 is busy — and a wrong guess is not a slower preview,
//     it is "no preview host answered" while one is running.
// ============================================================

/** Where a locally-run host listens unless told otherwise */
import { PREVIEW_HOST_DISCOVERY_PATH, previewOrigin } from "./preview-host";

/** Where a locally-run host listens unless told otherwise */
export const DEFAULT_PREVIEW_HOST_ORIGIN = "http://127.0.0.1:5174";

/**
 * Where the dev server answers "which origin is the host on?".
 *
 * A SAME-ORIGIN path, not a port to try. The plugin starts the host inside
 * the Vite process and it walks upward from 5174 when that port is busy, so
 * the port is a fact only the dev server knows. A hardcoded guess that is
 * wrong is not a degraded preview — it is an unreachable host, a silent fall
 * back to the sandboxed path, and a pane that reports "no preview host
 * answered" while one is running.
 *
 * Declared in ./preview-host so the Vite plugin can share the exact string
 * without importing this module, which is browser-only.
 */
export { PREVIEW_HOST_DISCOVERY_PATH };

/** Short: the host is either there, or it is not worth waiting for. */
const PROBE_TIMEOUT_MS = 1_200;

export interface PreviewHostPublish {
  id: string;
  url: string;
  origin: string;
}

export interface PreviewHostOutcome {
  hosted: PreviewHostPublish | null;
  /** One sentence for the preview console explaining the path taken */
  notice: string;
}

/**
 * How long a FAILED probe is trusted.
 *
 * Success is remembered for the session, but a failure must not be: a host
 * that gets started while the app is running has to be picked up by the next
 * build. Memoizing the failure meant starting the host changed nothing until
 * the whole app was reloaded — and the only sign was a console line saying no
 * host answered, which by then was no longer true.
 */
export const PROBE_RETRY_MS = 5_000;

/** Fetch-like, and a clock, so tests never open a socket or wait */
export interface PreviewHostDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /**
   * Who this publish belongs to — a conversation id.
   *
   * Previews are per-thread, so releasing is per-thread: publishing thread
   * B's build used to drop the id of thread A's, which is still framed and
   * still being looked at, leaving it a 404 in a pane that reported a
   * successful build. The same singleton mistake as the store's build slot,
   * one layer down.
   */
  key?: string;
}

/**
 * The origin to publish to, or null when this environment has no host.
 *
 * `VITE_PREVIEW_ORIGIN` wins wherever it is set — that is how a deployed
 * app points at a hosted origin. Otherwise dev falls back to the local
 * host's default port, and a production build without the variable has no
 * host at all rather than a URL that cannot exist.
 */
export function configuredPreviewHostOrigin(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): string | null {
  const explicit = explicitPreviewHostOrigin(env);
  if (explicit) return explicit;
  return env.DEV === true ? DEFAULT_PREVIEW_HOST_ORIGIN : null;
}

/**
 * `VITE_PREVIEW_ORIGIN`, or null.
 *
 * Separate from the default on purpose: "the developer named a host" and "no
 * host was named, so dev uses the usual port" are different facts, and the
 * second one is a guess that DISCOVERY is supposed to replace. Treating the
 * default as configuration would skip discovery and then report the guessed
 * port as a missing host — while a host was running on another port.
 */
export function explicitPreviewHostOrigin(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): string | null {
  const explicit = typeof env.VITE_PREVIEW_ORIGIN === "string" ? env.VITE_PREVIEW_ORIGIN.trim() : "";
  return explicit ? explicit.replace(/\/+$/, "") : null;
}

/** Whether this build is a dev server, and may therefore discover a host */
export function isDevEnvironment(
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): boolean {
  return env.DEV === true;
}

/**
 * Whether a build's URL came from the host.
 *
 * A blob URL means the fallback path: same origin as the app, isolated only
 * by the frame's sandbox, capabilities shimmed. Only an absolute http(s)
 * URL carries the guarantees the host provides.
 */
export function isHostedPreviewUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/** What the dev server said about its host */
export interface PreviewHostDiscovery {
  origin: string | null;
  /** Why there is none — the plugin's own words, shown to the developer */
  error: string | null;
}

/** Settled probe results, with the time they were taken */
const probeResults = new Map<string, { ok: boolean; at: number }>();
/** Settled discovery results, same success/failure rule as the probe */
const discoveryResults = new Map<string, { value: PreviewHostDiscovery; at: number }>();
/** Probes in flight, so concurrent rebuilds share one attempt */
const probeInFlight = new Map<string, Promise<boolean>>();
/**
 * The preview each publisher currently has live, by key.
 *
 * A map, not a slot. One slot meant the second preview published erased the
 * first one's record — and, far worse, rebuilding thread B deleted thread A's
 * document from the host while thread A's frame was still showing it. The
 * same singleton the store's build slot had, one layer down.
 *
 * `host` is the origin to talk to (its `/publish`, `/p/<id>` endpoints);
 * `url` is the preview's own origin, which is where the frame points. They
 * are different origins on purpose, and conflating them would send a DELETE
 * to the preview instead of the host.
 */
const livePreviews = new Map<string, { host: string; id: string; url: string }>();
/** The last notice handed to the caller, so the console is not spammed */
let lastNotice: string | null = null;

/** Test seam: forget probes and the live preview */
export function resetPreviewHostClient(): void {
  probeResults.clear();
  probeInFlight.clear();
  discoveryResults.clear();
  livePreviews.clear();
  lastNotice = null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is a host listening? Memoised per origin: the answer cannot change inside
 * one session without a page reload, and the cost of asking is a connection
 * attempt on the app's critical path.
 */
export function probePreviewHost(origin: string, deps: PreviewHostDeps = {}): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  const settled = probeResults.get(origin);
  // A success holds for the session; a failure expires, so the next build
  // retries instead of reporting an absence that may no longer be true.
  if (settled && (settled.ok || now - settled.at < PROBE_RETRY_MS)) {
    return Promise.resolve(settled.ok);
  }
  const running = probeInFlight.get(origin);
  if (running) return running;

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const attempt = (async () => {
    let ok = false;
    if (typeof fetchImpl === "function") {
      try {
        const res = await fetchWithTimeout(
          fetchImpl,
          `${origin}/health`,
          { method: "GET", mode: "cors", cache: "no-store" },
          deps.timeoutMs ?? PROBE_TIMEOUT_MS
        );
        ok = res.ok;
      } catch {
        ok = false;
      }
    }
    probeResults.set(origin, { ok, at: deps.now?.() ?? Date.now() });
    probeInFlight.delete(origin);
    return ok;
  })();
  probeInFlight.set(origin, attempt);
  return attempt;
}

/**
 * Asks the dev server which origin its preview host is on.
 *
 * Memoised on the same rule as the probe: a SUCCESS holds for the session (a
 * host does not move between two builds), a FAILURE expires, so a dev server
 * restarted with the plugin in place is picked up by the next rebuild.
 *
 * Silent by design. Most environments have no such endpoint — a deployed
 * build, a plain static server, a dev server started before the plugin
 * existed — and in all of those the answer is simply "ask the default port".
 */
export async function discoverPreviewHost(deps: PreviewHostDeps = {}): Promise<PreviewHostDiscovery> {
  const now = deps.now?.() ?? Date.now();
  const settled = discoveryResults.get(PREVIEW_HOST_DISCOVERY_PATH);
  if (settled && (settled.value.origin !== null || now - settled.at < PROBE_RETRY_MS)) {
    return settled.value;
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let value: PreviewHostDiscovery = { origin: null, error: null };
  if (typeof fetchImpl === "function") {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        PREVIEW_HOST_DISCOVERY_PATH,
        { method: "GET", cache: "no-store" },
        deps.timeoutMs ?? PROBE_TIMEOUT_MS
      );
      // Content type matters: a deployed single-page app answers ANY path
      // with its index.html and a 200, and parsing that as a host would turn
      // a production app into a client for an origin that does not exist.
      const type = res.headers?.get?.("content-type") ?? "";
      if (res.ok && type.includes("application/json")) {
        const payload = (await res.json()) as { origin?: unknown; error?: unknown };
        value = {
          origin:
            typeof payload?.origin === "string" && payload.origin
              ? payload.origin.replace(/\/+$/, "")
              : null,
          error:
            typeof payload?.error === "string" && payload.error ? payload.error : null,
        };
      }
    } catch {
      value = { origin: null, error: null };
    }
  }
  discoveryResults.set(PREVIEW_HOST_DISCOVERY_PATH, { value, at: deps.now?.() ?? Date.now() });
  return value;
}

/**
 * The origin to publish to, and — when there is none — why.
 *
 * Order matters. An explicitly configured origin is the production answer
 * and is never second-guessed. In dev the dev server is asked, because only
 * it knows which port its host actually got. If it does not answer, the
 * default port is still tried: that covers a host started by hand, which is
 * the one case where the port genuinely is 5174.
 */
async function resolvePreviewHostOrigin(
  deps: PreviewHostDeps
): Promise<{ origin: string | null; discoveryError: string | null }> {
  const explicit = explicitPreviewHostOrigin();
  if (explicit) return { origin: explicit, discoveryError: null };
  if (!isDevEnvironment()) return { origin: null, discoveryError: null };

  const found = await discoverPreviewHost(deps);
  if (found.origin) return { origin: found.origin, discoveryError: null };
  return { origin: DEFAULT_PREVIEW_HOST_ORIGIN, discoveryError: found.error };
}

/**
 * Publishes a built document and returns the URL to frame it at.
 *
 * The previous preview is released in the same call: ids are per-build, and
 * leaving the old ones live would mean an unbounded set of documents, each
 * one a readable copy of the user's source.
 */
export async function publishPreviewDocument(
  document: string,
  deps: PreviewHostDeps = {}
): Promise<PreviewHostOutcome> {
  const { origin, discoveryError } = await resolvePreviewHostOrigin(deps);
  if (!origin) {
    return {
      hosted: null,
      notice:
        "No preview host is configured, so this build runs as an inline sandboxed document: " +
        "storage, cookies and locks are emulated in memory and reset on rebuild. " +
        "Set VITE_PREVIEW_ORIGIN to serve previews from their own origin.",
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!(await probePreviewHost(origin, deps))) {
    return {
      hosted: null,
      notice:
        `No preview host answered at ${origin}${discoveryError ? ` — ${discoveryError}` : ""}, ` +
        "so this build runs as an inline sandboxed document: its router has no path to match, " +
        "and storage, cookies and locks are emulated in memory and reset on rebuild. " +
        "Start it with: node src/features/chat/preview/host/preview-host-server.ts",
    };
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      `${origin}/publish`,
      {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: document,
      },
      // Publishing is local and synchronous on the other side; the timeout
      // only exists so a wedged host cannot hang a rebuild forever.
      10_000
    );
  } catch (err) {
    return {
      hosted: null,
      notice: `Publishing to ${origin} failed (${err instanceof Error ? err.message : String(err)}) — serving this build inline instead.`,
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      hosted: null,
      notice: `${origin} refused the build (HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}) — serving it inline instead.`,
    };
  }

  const payload = (await response.json().catch(() => null)) as { id?: string; path?: string } | null;
  if (!payload?.id || !payload.path) {
    return { hosted: null, notice: `${origin} returned no preview id — serving this build inline instead.` };
  }

  // The preview's OWN origin, at its root: `<id>.localhost:<port>/`. A
  // router-based app reads `location.pathname`, so the document has to be
  // served as the app's own home page (serving it at `/p/<id>/` failed every
  // route any app has), and it has to be an origin no other preview shares
  // (serving every preview at the host's root meant the newest build answered
  // every frame, so two chats showed the same app).
  const previewUrl = `${previewOrigin(origin, payload.id)}/`;
  const key = deps.key ?? "default";
  const previous = livePreviews.get(key);
  livePreviews.set(key, { host: origin, id: payload.id, url: previewUrl });
  if (previous && previous.id !== payload.id) void releasePreview(previous.host, previous.id, deps);

  return {
    hosted: { id: payload.id, url: previewUrl, origin: new URL(previewUrl).origin },
    notice:
      `Serving this preview from its own origin on ${origin} — so localStorage, cookies, ` +
      "IndexedDB and Web Locks work natively, the app's storage is out of reach, and " +
      "another chat's preview cannot displace this one.",
  };
}

/** Drops a published document. Best-effort: the store evicts on its own. */
export async function releasePreview(
  origin: string,
  id: string,
  deps: PreviewHostDeps = {}
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    await fetchWithTimeout(
      fetchImpl,
      `${origin}/p/${id}`,
      { method: "DELETE", mode: "cors", cache: "no-store" },
      deps.timeoutMs ?? PROBE_TIMEOUT_MS
    );
  } catch {
    // A host that has gone away has already released it.
  }
  for (const [key, live] of livePreviews) {
    if (live.id === id) livePreviews.delete(key);
  }
}

/**
 * Releases the live preview of one publisher, or all of them.
 *
 * Prefer a key: previews are cached per thread and the pane can be unmounted
 * while another thread's build is on screen, so "release everything" is only
 * right when the whole app is going away.
 */
export function releaseLivePreview(deps: PreviewHostDeps = {}): void {
  const key = deps.key;
  const entries = key
    ? ([[key, livePreviews.get(key)]] as const)
    : ([...livePreviews.entries()] as const);
  for (const [k, live] of entries) {
    if (!live) continue;
    livePreviews.delete(k);
    void releasePreview(live.host, live.id, deps);
  }
}

/**
 * The notice for the console, deduped. Returns null when nothing new needs
 * saying, so a rebuild loop does not repeat the same paragraph forever.
 */
export function previewHostNotice(outcome: PreviewHostOutcome): string | null {
  if (outcome.notice === lastNotice) return null;
  lastNotice = outcome.notice;
  return outcome.notice;
}
