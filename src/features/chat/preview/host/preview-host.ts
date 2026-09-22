// ============================================================
// Preview Host — Serving a Built Preview From Its Own Origin
// ============================================================
// The preview used to be a `srcdoc` document inside a sandboxed frame.
// That frame has no `allow-same-origin`, so its origin is OPAQUE, and an
// opaque origin is not a secure context: localStorage, sessionStorage,
// cookies, IndexedDB, Web Locks, `crypto.randomUUID` and service workers
// are all denied. The runtime answered that by patching capabilities into
// the document one crash at a time — a shim per library, per report, with
// state that resets on every rebuild and a failure surface that grows with
// whatever the user is previewing.
//
// This module is the other answer: give the preview a REAL origin.
//
// `http://127.0.0.1:<port>` is a potentially-trustworthy origin, so the
// frame is a secure context and every one of those APIs works because the
// browser grants them, not because we impersonated them. Isolation does
// not come from crippling the frame — it comes from the origin being
// DIFFERENT from the app's (a different port is a different origin), which
// is how StackBlitz and CodeSandbox separate a sandbox from the editor.
// The previewed app therefore shares no storage, no cookies and no
// JavaScript realm with the app that is hosting it.
//
// What replaces the risk that `sandbox` was there to contain:
//
//   • `frame-ancestors` names the ONE origin that published this build, so
//     no other page can embed it;
//   • the document's own CSP carries `sandbox` WITH `allow-same-origin` —
//     the origin is preserved (that is the point) while top-level
//     navigation, popups and pointer lock stay denied;
//   • publishing is refused unless the request comes from an allowed
//     origin, and a preview id is unguessable, so a page cannot discover
//     or overwrite someone else's build.
//
// Pure: a request object in, a response object out. Nothing here opens a
// socket, touches `node:http`, or reads the clock in a way a test cannot
// pin — which is what lets the serving contract (and especially the
// `allow-same-origin` in it) be asserted without a browser.
// ============================================================

/**
 * Where the dev server answers "which origin is the host on?".
 *
 * Defined HERE, in the module both sides already share, rather than in the
 * client: the Vite plugin must not import the client module (it reads
 * `import.meta.env`, which drags a browser file into the Node tsconfig), and
 * a path spelled twice is a path that drifts.
 */
export const PREVIEW_HOST_DISCOVERY_PATH = "/__preview-host";

export interface PreviewHostOptions {
  /**
   * Origins allowed to PUBLISH and to delete. In development these are the
   * app's own dev origins; a deployed host lists its app's domain.
   */
  allowedOrigins: readonly string[];
  /** Refuse a document larger than this (a runaway bundle, not a preview) */
  maxDocumentBytes: number;
  /** How many previews the store keeps before evicting the oldest */
  maxPreviews: number;
}

export const PREVIEW_HOST_DEFAULTS: PreviewHostOptions = {
  allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  maxDocumentBytes: 8 * 1024 * 1024,
  maxPreviews: 8,
};

/** Hostnames that mean "this machine" */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Whether an origin may publish.
 *
 * Listed origins, plus ANY loopback origin — and the second half is not
 * laziness. The dev server takes the next free port when its usual one is
 * busy (another checkout, a second dev server, the app itself already
 * running), and a fixed allowlist would then lock the app out of its own
 * host: previews would silently fall back to the inline path for a reason
 * nobody could see from the pane. A page that is already running ON the
 * user's machine gains nothing here — it can only publish its own
 * documents, cannot read anyone else's, and cannot guess an id.
 */
export function isAllowedPublisher(origin: string | null, allowed: readonly string[]): boolean {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

export interface PublishedPreview {
  id: string;
  /** The complete document, exactly as the bundler produced it */
  document: string;
  /**
   * The origin that published it. It is the only origin allowed to FRAME
   * the result, so opening a preview in a tab does not make it embeddable
   * by anyone who learns the id.
   */
  ownerOrigin: string | null;
  createdAt: number;
  /**
   * Insertion order. Time alone is not enough to say which build is newest:
   * two publishes in the same millisecond are ordinary, and a comparison that
   * cannot order them serves the wrong document from the origin root.
   */
  seq: number;
}

export interface PreviewHostRequest {
  method: string;
  /** Path only — `/p/<id>/`, `/health`, `/publish` */
  path: string;
  /** Header names lowercased by the adapter */
  headers: Record<string, string | undefined>;
  /** Request body, already read (the adapter applies the size cap first) */
  body?: string | null;
  now?: number;
}

export interface PreviewHostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PreviewHost {
  previews: Map<string, PublishedPreview>;
  options: PreviewHostOptions;
  /** Monotonic publish counter; see PublishedPreview.seq */
  seq: number;
}

/** A fresh store. State lives here, not in module scope, so tests are hermetic. */
export function createPreviewHost(options: Partial<PreviewHostOptions> = {}): PreviewHost {
  return {
    previews: new Map(),
    options: { ...PREVIEW_HOST_DEFAULTS, ...options },
    seq: 0,
  };
}

/** 128 bits of hex — unguessable, and safe as a URL path segment */
export function newPreviewId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ids the store will answer for. Anything else is a 404, never a lookup. */
const ID_PATTERN = /^[a-f0-9]{16,64}$/;

export function previewPath(id: string): string {
  return `/p/${id}/`;
}

// ── The serving contract ─────────────────────────────────────
//
// This is the load-bearing header. `sandbox` restricts the document,
// `allow-same-origin` keeps the origin real, and the two together are what
// make the preview a normal web page in an isolated realm rather than a
// capability-starved one.
//
// Removing `allow-same-origin` here would silently return every preview to
// memory-only storage: the frame keeps loading, storage access starts
// throwing again, the runtime's shims quietly take over, and the only
// symptom is state that resets on rebuild. preview-host.test.ts pins it.
export function previewDocumentPolicy(ownerOrigin: string | null): string {
  const ancestors = ownerOrigin ?? "'none'";
  return [
    "sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads",
    `frame-ancestors ${ancestors}`,
    // The previewed app is a whole application: it may fetch its own APIs,
    // load remote fonts and images, and expect inline evaluation. This
    // policy belongs to a disposable origin, so it is deliberately looser
    // than the app's — and it is the app's policy that no longer has to be
    // loosened to accommodate a preview.
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
    "script-src 'unsafe-inline' 'unsafe-eval' * data: blob:",
    "style-src 'unsafe-inline' * data:",
    "img-src * data: blob:",
    "font-src * data:",
    "media-src * data: blob:",
    "connect-src *",
    "worker-src * data: blob:",
    "base-uri 'none'",
    "form-action *",
  ].join("; ");
}

/**
 * The response for a served document, wherever it is served from.
 *
 * One place, because the policy in it is the design: `sandbox
 * allow-same-origin` keeps the origin real, `frame-ancestors` names the one
 * origin that may embed the build, and no CORS headers are sent at all — a
 * preview is the user's own source and must not be readable by a page that
 * merely guesses a URL.
 */
function documentResponse(preview: PublishedPreview): PreviewHostResponse {
  return {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": previewDocumentPolicy(preview.ownerOrigin),
    },
    body: preview.document,
  };
}

function json(status: number, payload: unknown, cors: Record<string, string> = {}): PreviewHostResponse {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
    body: JSON.stringify(payload),
  };
}

function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  if (!origin || !isAllowedPublisher(origin, allowed)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    // The allowlist is per-origin, so a shared cache must not serve one
    // origin's permission to another.
    Vary: "Origin",
  };
}

function refused(origin: string | null, allowed: readonly string[]): PreviewHostResponse {
  return json(
    403,
    {
      ok: false,
      error: "This origin may not publish previews.",
      origin,
      allowed: [...allowed],
      hint: "Start the host with PREVIEW_HOST_ORIGINS=<your app origin> (comma separated).",
    },
    corsHeaders(origin, allowed)
  );
}

/**
 * Routes one request. The order of these checks is the contract:
 * who is asking, then how big the answer may be, then whether it exists.
 */
export function handlePreviewRequest(
  request: PreviewHostRequest,
  host: PreviewHost
): PreviewHostResponse {
  const { options } = host;
  const method = request.method.toUpperCase();
  const origin = request.headers.origin ?? null;
  const allowed = options.allowedOrigins;
  const path = request.path.split("?")[0] ?? request.path;

  // Preflight: the app posts a document across origins, so the browser asks
  // first. Answering only for allowed origins keeps this from becoming an
  // open endpoint that any page can write to.
  if (method === "OPTIONS") {
    return {
      status: 204,
      headers: {
        ...corsHeaders(origin, allowed),
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "600",
      },
      body: "",
    };
  }

  if (path === "/health") {
    // Reachability probe. The app uses it to decide whether previews get a
    // real origin at all, so it must answer even when nothing is published.
    return json(
      200,
      { ok: true, previews: host.previews.size, version: 1 },
      corsHeaders(origin, allowed)
    );
  }

  if (path === "/publish") {
    if (method !== "POST") return json(405, { ok: false, error: "Use POST to publish." });
    if (!isAllowedPublisher(origin, allowed)) return refused(origin, allowed);

    const document = request.body ?? "";
    if (document.length === 0) {
      return json(400, { ok: false, error: "The request body must be the built document." }, corsHeaders(origin, allowed));
    }
    if (document.length > options.maxDocumentBytes) {
      return json(
        413,
        {
          ok: false,
          error: `The document is ${document.length} bytes; this host serves at most ${options.maxDocumentBytes}.`,
        },
        corsHeaders(origin, allowed)
      );
    }

    const id = newPreviewId();
    host.previews.set(id, {
      id,
      document,
      ownerOrigin: origin,
      createdAt: request.now ?? Date.now(),
      seq: ++host.seq,
    });

    // Evict oldest first: a preview is disposable, and an unbounded map is
    // a memory leak in a process the user leaves running all day.
    while (host.previews.size > options.maxPreviews) {
      const oldest = [...host.previews.values()].sort((a, b) => a.seq - b.seq)[0];
      if (!oldest) break;
      host.previews.delete(oldest.id);
    }

    return json(200, { ok: true, id, path: previewPath(id) }, corsHeaders(origin, allowed));
  }

  const match = /^\/p\/([^/]+)\/?$/.exec(path);
  if (match) {
    const id = match[1]!;
    if (!ID_PATTERN.test(id)) return json(404, { ok: false, error: "No such preview." });

    if (method === "DELETE") {
      if (!isAllowedPublisher(origin, allowed)) return refused(origin, allowed);
      host.previews.delete(id);
      return { status: 204, headers: corsHeaders(origin, allowed), body: "" };
    }
    if (method !== "GET" && method !== "HEAD") {
      return json(405, { ok: false, error: "Use GET or DELETE." });
    }

    const preview = host.previews.get(id);
    if (!preview) {
      // Named, not silent: a stale iframe src is the difference between a
      // blank frame and a sentence explaining that the host restarted.
      return json(404, {
        ok: false,
        error:
          "No preview with that id. The host was restarted, or a newer build replaced it — rebuild from the preview pane.",
      });
    }

    return documentResponse(preview);
  }

  // ── The application's own routes ─────────────────────────────
  //
  // A router-based app reads `location.pathname`. The document used to be
  // served at `/p/<id>/`, which no route in any app matches
  // (`No routes matched location "/p/abc123/"`), and in the srcdoc fallback
  // it is worse: that document's location is `about:srcdoc`, so the path
  // react-router tries to match is literally "srcdoc" — the reported black
  // frame, from an app that is perfectly fine.
  //
  // So the newest build is served at the ORIGIN ROOT, and every path that is
  // not one of this host's own endpoints falls back to it. That is exactly
  // what a dev server does for a single-page app, and matching a dev server
  // is the whole fidelity target: `/` and any client route the app pushes
  // both match now.
  if (method === "GET" || method === "HEAD") {
    const looksLikeAsset = /\.[a-z0-9]{1,8}$/i.test(path);
    // A path with a file extension is not a route. Serving HTML for it would
    // turn a missing image into a syntax error in the console, so it is
    // honestly reported as missing instead.
    if (!looksLikeAsset) {
      const newest = [...host.previews.values()].sort((a, b) => b.seq - a.seq)[0];
      if (!newest) {
        return json(404, { ok: false, error: "No preview has been published yet." });
      }
      return documentResponse(newest);
    }
  }

  return json(404, { ok: false, error: `No route for ${method} ${path}.` });
}
