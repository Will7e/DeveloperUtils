// ============================================================
// Preview Host Tests — the Serving Contract and the Fallback
// ============================================================
// The preview host moves isolation from "cripple the frame" to "separate
// origin". Two properties carry that move, and neither is visible in a
// running app until it is wrong:
//
//   • the served document keeps `sandbox allow-same-origin` — drop it and
//     every preview silently returns to memory-only storage (the frame
//     still loads, storage access just throws again, and the runtime's
//     shims quietly take over);
//   • the frame-ancestor is the ONE origin that published the build — widen
//     it and any page can embed the user's source.
//
// The other half of this file is the fallback, because it is the path a
// developer actually hits: with no host listening, a build must still
// render, must be told WHY it is on the inline path, and must not hand out
// a blob URL (a blob inherits the APP's origin, so "open in new tab" would
// run previewed npm code with the app's storage in reach).
// ============================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createPreviewHost,
  handlePreviewRequest,
  isAllowedPublisher,
  newPreviewId,
  previewDocumentPolicy,
  previewIdFromHostHeader,
  previewOrigin,
  previewPath,
} from "./preview-host";
import type { PreviewHost, PreviewHostRequest } from "./preview-host";
import {
  DEFAULT_PREVIEW_HOST_ORIGIN,
  PREVIEW_HOST_DISCOVERY_PATH,
  PROBE_RETRY_MS,
  configuredPreviewHostOrigin,
  discoverPreviewHost,
  explicitPreviewHostOrigin,
  isHostedPreviewUrl,
  previewHostNotice,
  probePreviewHost,
  publishPreviewDocument,
  resetPreviewHostClient,
} from "./preview-host-client";

const APP_ORIGIN = "http://localhost:5173";
const DOCUMENT = "<!doctype html><html><body>built</body></html>";

function request(overrides: Partial<PreviewHostRequest> = {}): PreviewHostRequest {
  return { method: "GET", path: "/health", headers: {}, ...overrides };
}

function publishTo(host: PreviewHost, body = DOCUMENT, origin = APP_ORIGIN) {
  return handlePreviewRequest(
    request({ method: "POST", path: "/publish", headers: { origin }, body }),
    host
  );
}

/** Publishes once and returns the id, so document tests can use it */
function publishAndReadId(host: PreviewHost): string {
  const parsed = JSON.parse(publishTo(host).body) as { id: string };
  return parsed.id;
}

// ── The handler ──────────────────────────────────────────────

describe("preview host — publishing", () => {
  let host: PreviewHost;
  beforeEach(() => {
    host = createPreviewHost();
  });

  it("answers a reachability probe so the app can decide which path to take", () => {
    const response = handlePreviewRequest(request({ headers: { origin: APP_ORIGIN } }), host);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, previews: 0 });
  });

  it("accepts a document from an allowed origin and returns an unguessable path", () => {
    const response = publishTo(host);
    expect(response.status).toBe(200);

    const payload = JSON.parse(response.body) as { ok: boolean; id: string; path: string };
    expect(payload.ok).toBe(true);
    // 32 hex characters: not enumerable by a page that wants someone
    // else's source.
    expect(payload.id).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.path).toBe(previewPath(payload.id));
    expect(host.previews.size).toBe(1);
  });

  it("refuses an origin that is not allowed to publish, and says what to do", () => {
    const response = publishTo(host, DOCUMENT, "https://evil.example");
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, origin: "https://evil.example" });
    // No CORS header is handed to a refused origin.
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(host.previews.size).toBe(0);
  });

  it("refuses a publisher with no origin at all", () => {
    const response = publishTo(host, DOCUMENT, "");
    expect(response.status).toBe(403);
    expect(host.previews.size).toBe(0);
  });

  it("accepts any loopback origin, so a moved dev-server port is not an outage", () => {
    // Vite takes the next free port when 5173 is busy, and a fixed allowlist
    // would leave the app unable to publish to its own host — a preview that
    // falls back to the sandboxed path with nothing in the pane explaining
    // why. Loopback hostnames are the machine the host is already on.
    const appended = createPreviewHost({ allowedOrigins: ["http://localhost:5173"] });
    for (const origin of [
      "http://localhost:5173",
      "http://localhost:5199",
      "http://127.0.0.1:5175",
      "http://[::1]:5173",
    ]) {
      expect(isAllowedPublisher(origin, appended.options.allowedOrigins), origin).toBe(true);
      expect(publishTo(appended, DOCUMENT, origin).status, origin).toBe(200);
    }

    // …and the loopback rule is a hostname rule, not a prefix rule: a suffix
    // that merely STARTS with a loopback name is a different machine.
    for (const origin of [
      "https://evil.example",
      "http://127.0.0.1.evil.example",
      "https://localhost:5173",
      "null",
    ]) {
      expect(isAllowedPublisher(origin, appended.options.allowedOrigins), origin).toBe(false);
      expect(publishTo(appended, DOCUMENT, origin).status, origin).toBe(403);
    }
    expect(isAllowedPublisher(null, appended.options.allowedOrigins)).toBe(false);
  });

  it("refuses an empty body and one past the size cap", () => {
    expect(publishTo(host, "").status).toBe(400);

    const small = createPreviewHost({ maxDocumentBytes: 64 });
    expect(publishTo(small, "x".repeat(65)).status).toBe(413);
    expect(small.previews.size).toBe(0);
  });

  it("keeps only the newest previews", () => {
    const ring = createPreviewHost({ maxPreviews: 2 });
    const first = publishAndReadId(ring);
    const second = publishAndReadId(ring);
    const third = publishAndReadId(ring);

    expect(ring.previews.size).toBe(2);
    expect(ring.previews.has(first)).toBe(false);
    expect(ring.previews.has(second)).toBe(true);
    expect(ring.previews.has(third)).toBe(true);
  });

  it("answers a preflight only for an allowed origin", () => {
    const allowed = handlePreviewRequest(
      request({ method: "OPTIONS", path: "/publish", headers: { origin: APP_ORIGIN } }),
      host
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers["Access-Control-Allow-Origin"]).toBe(APP_ORIGIN);
    expect(allowed.headers["Access-Control-Allow-Methods"]).toContain("POST");

    const denied = handlePreviewRequest(
      request({ method: "OPTIONS", path: "/publish", headers: { origin: "https://evil.example" } }),
      host
    );
    expect(denied.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });
});

describe("preview host — the served document", () => {
  it("serves the built document with a policy that keeps its origin", () => {
    const host = createPreviewHost();
    const id = publishAndReadId(host);

    const response = handlePreviewRequest(request({ path: previewPath(id) }), host);
    expect(response.status).toBe(200);
    expect(response.body).toBe(DOCUMENT);
    expect(response.headers["Content-Type"]).toContain("text/html");
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");

    const policy = response.headers["Content-Security-Policy"]!;
    // THE guard. `allow-same-origin` is what makes the preview a secure
    // context with real storage; without it the browser treats the frame as
    // opaque and every capability the host exists to provide is gone again.
    expect(policy).toContain("sandbox allow-scripts allow-same-origin");
    // …and the origin it keeps is the wheel that must NOT be given away:
    // top-level navigation stays denied, so a preview cannot navigate the
    // app away even though it is a real document.
    expect(policy).not.toContain("allow-top-navigation");
  });

  it("lets only the publishing origin frame it", () => {
    const host = createPreviewHost();
    const id = publishAndReadId(host);
    const policy = handlePreviewRequest(request({ path: previewPath(id) }), host)
      .headers["Content-Security-Policy"]!;
    expect(policy).toContain(`frame-ancestors ${APP_ORIGIN}`);

    // A preview of unknown parentage is framed by nobody, rather than by
    // everybody.
    expect(previewDocumentPolicy(null)).toContain("frame-ancestors 'none'");
  });

  it("does not expose a preview to other origins", () => {
    const host = createPreviewHost();
    const id = publishAndReadId(host);
    const response = handlePreviewRequest(
      request({ path: previewPath(id), headers: { origin: "https://evil.example" } }),
      host
    );
    // No CORS header on the document route: another origin cannot read the
    // user's source even if it learns the id.
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("serves the newest build at the ORIGIN ROOT, so the app's routes match", () => {
    // The reported failure: react-router's `No routes matched location "srcdoc"`
    // — a router reads location.pathname, and no other reading of the document
    // gives it a path any route can match.
    const host = createPreviewHost();
    expect(handlePreviewRequest(request({ path: "/" }), host).status).toBe(404);

    const id = publishAndReadId(host);
    const root = handlePreviewRequest(request({ path: "/" }), host);
    expect(root.status).toBe(200);
    expect(root.body).toBe(DOCUMENT);
    // Same policy as the id route: a real origin, and one permitted embedder.
    expect(root.headers["Content-Security-Policy"]).toContain("sandbox allow-scripts allow-same-origin");
    expect(root.headers["Content-Security-Policy"]).toContain(`frame-ancestors ${APP_ORIGIN}`);

    // Any client route falls back to the document, like a dev server…
    for (const path of ["/lunch", "/admin/settings", "/deep/path"]) {
      expect(handlePreviewRequest(request({ path }), host).body, path).toBe(DOCUMENT);
    }
    // …while a path naming a file is reported missing rather than answered
    // with HTML, which would surface as a syntax error instead of a 404.
    for (const path of ["/logo.png", "/src/main.jsx", "/assets/app.css"]) {
      expect(handlePreviewRequest(request({ path }), host).status, path).toBe(404);
    }
    // The immutable id route still works, which is what makes a specific
    // build addressable while the root moves on.
    expect(handlePreviewRequest(request({ path: previewPath(id) }), host).body).toBe(DOCUMENT);
  });

  it("root-serves the NEWEST build even when two land in the same millisecond", () => {
    const host = createPreviewHost();
    publishTo(host, "<html>first</html>");
    publishTo(host, "<html>second</html>");
    expect(handlePreviewRequest(request({ path: "/" }), host).body).toBe("<html>second</html>");
  });

  it("names a preview it no longer holds instead of serving nothing", () => {
    const host = createPreviewHost();
    const missing = handlePreviewRequest(request({ path: previewPath("a".repeat(32)) }), host);
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error).toContain("rebuild");

    // A path that is not an id is never looked up, so traversal and
    // uppercase ids are the same 404 as an evicted preview.
    for (const path of ["/p/file.txt", "/p/../secret", `/p/${"A".repeat(32)}`, "/p/short"]) {
      expect(handlePreviewRequest(request({ path }), host).status, path).toBe(404);
    }
  });

  it("deletes a preview only for an allowed origin", () => {
    const host = createPreviewHost();
    const id = publishAndReadId(host);

    const denied = handlePreviewRequest(
      request({ method: "DELETE", path: `/p/${id}`, headers: { origin: "https://evil.example" } }),
      host
    );
    expect(denied.status).toBe(403);
    expect(host.previews.has(id)).toBe(true);

    const allowed = handlePreviewRequest(
      request({ method: "DELETE", path: `/p/${id}`, headers: { origin: APP_ORIGIN } }),
      host
    );
    expect(allowed.status).toBe(204);
    expect(host.previews.has(id)).toBe(false);
  });

  it("rejects unsupported methods, and treats an unknown path like a dev server", () => {
    const host = createPreviewHost();
    const id = publishAndReadId(host);
    expect(handlePreviewRequest(request({ method: "PUT", path: "/publish" }), host).status).toBe(405);
    expect(handlePreviewRequest(request({ method: "POST", path: `/p/${id}` }), host).status).toBe(405);

    // A bare path is a client route and is served the app (see the root test);
    // a path that names a FILE is genuinely missing, and says which.
    const missingAsset = handlePreviewRequest(request({ path: "/nope.js" }), host);
    expect(missingAsset.status).toBe(404);
    expect(JSON.parse(missingAsset.body).error).toContain("/nope.js");

    // With nothing published, even a route has nothing to serve.
    const nothingYet = handlePreviewRequest(request({ path: "/nope" }), createPreviewHost());
    expect(nothingYet.status).toBe(404);
    expect(JSON.parse(nothingYet.body).error).toContain("No preview has been published");
  });
});

describe("preview host — one origin per preview", () => {
  // The reported problem: two chats, two repositories, one pane each — and
  // both showed the same app, because every preview was served from the
  // host's root and the newest build answered every frame.
  it("routes by the Host header, so two previews are two apps", () => {
    const host = createPreviewHost();
    const first = JSON.parse(publishTo(host, "<html>first</html>").body) as { id: string };
    const second = JSON.parse(publishTo(host, "<html>second</html>").body) as { id: string };
    const at = (id: string) => ({ host: `${id}.localhost:5174` });

    expect(handlePreviewRequest(request({ path: "/", headers: at(first.id) }), host).body).toBe(
      "<html>first</html>"
    );
    expect(handlePreviewRequest(request({ path: "/", headers: at(second.id) }), host).body).toBe(
      "<html>second</html>"
    );
    // A client route is the app's own route on ITS origin, and a path naming
    // a file is still an honest 404 rather than HTML.
    expect(
      handlePreviewRequest(request({ path: "/lunch", headers: at(first.id) }), host).body
    ).toBe("<html>first</html>");
    expect(
      handlePreviewRequest(request({ path: "/logo.png", headers: at(first.id) }), host).status
    ).toBe(404);
  });

  it("keeps the control endpoints off a preview's own origin", () => {
    // The preview is the user's own code. The surface that accepts writes is
    // not something it should be able to reach at all.
    const host = createPreviewHost();
    const id = publishAndReadId(host);
    const response = handlePreviewRequest(
      request({
        method: "POST",
        path: "/publish",
        headers: { host: `${id}.localhost:5174`, origin: APP_ORIGIN },
        body: DOCUMENT,
      }),
      host
    );
    expect(response.status).toBe(405);
    expect(host.previews.size).toBe(1);
  });

  it("names a preview it no longer holds, rather than serving another one", () => {
    // A frame left pointing at an evicted build must not silently receive
    // somebody else's document — that is how a preview reads as "showing the
    // wrong app" instead of "rebuild me".
    const host = createPreviewHost({ maxPreviews: 1 });
    const evicted = publishAndReadId(host);
    publishAndReadId(host);
    const response = handlePreviewRequest(
      request({ path: "/", headers: { host: `${evicted}.localhost:5174` } }),
      host
    );
    expect(response.status).toBe(404);
    expect(response.body).toContain("rebuild from the preview pane");
  });
});

describe("preview origins", () => {
  it("is a subdomain, on a name the resolver already treats as loopback", () => {
    const id = "a".repeat(32);
    // `127.0.0.1` cannot have subdomains — only the NAME `localhost` is
    // special-cased, by the resolver and by the browser's secure-context
    // rules — so the label is rewritten rather than reused. `<id>.127.0.0.1`
    // does not resolve at all.
    expect(previewOrigin("http://127.0.0.1:5174", id)).toBe(`http://${id}.localhost:5174`);
    expect(previewOrigin("http://localhost:5174", id)).toBe(`http://${id}.localhost:5174`);
    // A deployed host needs wildcard DNS and a wildcard certificate for this.
    expect(previewOrigin("https://preview.example.dev", id)).toBe(
      `https://${id}.preview.example.dev`
    );
    // A label that is not an id is never pasted into a hostname.
    expect(previewOrigin("http://127.0.0.1:5174", "not-an-id")).toBe("http://127.0.0.1:5174");
  });

  it("reads the preview id out of a Host header, and only an id", () => {
    const id = "b".repeat(32);
    expect(previewIdFromHostHeader(`${id}.localhost:5174`)).toBe(id);
    expect(previewIdFromHostHeader(`${id}.localhost`)).toBe(id);
    // The host's own origin carries no id, which is what keeps the control
    // endpoints reachable there and nowhere else.
    expect(previewIdFromHostHeader("127.0.0.1:5174")).toBeNull();
    expect(previewIdFromHostHeader("localhost:5174")).toBeNull();
    expect(previewIdFromHostHeader("[::1]:5174")).toBeNull();
    expect(previewIdFromHostHeader(undefined)).toBeNull();
  });
});

describe("preview ids", () => {
  it("are 128 bits of hex and do not repeat", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newPreviewId()));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/);
  });
});

// ── The client ───────────────────────────────────────────────

/** A fetch double that records calls and answers from a script */
function recorder(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return await handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function responding(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** A response that says what it is, which discovery has to check */
function typed(status: number, payload: unknown, contentType: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => payload,
    text: async () =>
      contentType.includes("json") ? JSON.stringify(payload) : String(payload),
  } as unknown as Response;
}

const json = (status: number, payload: unknown) =>
  typed(status, payload, "application/json; charset=utf-8");
const html = (status: number, body: string) =>
  typed(status, body, "text/html; charset=utf-8");

describe("preview host client — which origin, and which delivery path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPreviewHostClient();
  });

  it("prefers an explicitly configured host and trims it", () => {
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "  https://preview.example.dev/  ");
    expect(configuredPreviewHostOrigin()).toBe("https://preview.example.dev");
  });

  it("falls back to the local host in dev and to nothing in production", () => {
    expect(configuredPreviewHostOrigin({ DEV: true })).toBe(DEFAULT_PREVIEW_HOST_ORIGIN);
    // A deployed build with no host configured has no host — not a URL that
    // cannot exist.
    expect(configuredPreviewHostOrigin({ DEV: false })).toBeNull();
    expect(configuredPreviewHostOrigin({ DEV: true, VITE_PREVIEW_ORIGIN: "   " })).toBe(
      DEFAULT_PREVIEW_HOST_ORIGIN
    );
  });

  it("treats only an absolute http(s) URL as hosted", () => {
    // A blob inherits the app's origin — the delivery path that must never
    // be mistaken for a host.
    expect(isHostedPreviewUrl("blob:http://localhost:5173/abc")).toBe(false);
    expect(isHostedPreviewUrl("data:text/html,hi")).toBe(false);
    expect(isHostedPreviewUrl(null)).toBe(false);
    expect(isHostedPreviewUrl(undefined)).toBe(false);
    expect(isHostedPreviewUrl("http://127.0.0.1:5174/p/abc/")).toBe(true);
    expect(isHostedPreviewUrl("https://preview.example.dev/p/abc/")).toBe(true);
  });

  it("probes once per success and reports an absent host as absent", async () => {
    resetPreviewHostClient();
    const ok = recorder(() => responding(200, { ok: true }));
    await expect(probePreviewHost("http://127.0.0.1:5174", { fetchImpl: ok.fetchImpl })).resolves.toBe(true);
    await expect(probePreviewHost("http://127.0.0.1:5174", { fetchImpl: ok.fetchImpl })).resolves.toBe(true);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.url).toBe("http://127.0.0.1:5174/health");

    resetPreviewHostClient();
    const down = recorder(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(probePreviewHost("http://127.0.0.1:5174", { fetchImpl: down.fetchImpl })).resolves.toBe(false);
  });

  it("picks up a host that starts mid-session instead of trusting a stale failure", async () => {
    // Reported the hard way: starting the host changed nothing, because the
    // failed probe had been memoized for the whole session. Only a full app
    // reload recovered — and the console kept saying no host answered.
    resetPreviewHostClient();
    let now = 1_000;
    const down = recorder(() => {
      throw new Error("ECONNREFUSED");
    });
    const origin = "http://127.0.0.1:5174";
    await expect(probePreviewHost(origin, { fetchImpl: down.fetchImpl, now: () => now })).resolves.toBe(false);

    const up = recorder(() => responding(200, { ok: true }));
    // Immediately after, the failure is still fresh: no second attempt.
    await expect(probePreviewHost(origin, { fetchImpl: up.fetchImpl, now: () => now })).resolves.toBe(false);
    expect(up.calls).toHaveLength(0);

    // Once it expires, the next build asks again — which is what makes
    // "start the host, then rebuild" work.
    now += PROBE_RETRY_MS + 1;
    await expect(probePreviewHost(origin, { fetchImpl: up.fetchImpl, now: () => now })).resolves.toBe(true);
    expect(up.calls).toHaveLength(1);

    // And a SUCCESS is trusted for the rest of the session even if the clock
    // jumps, because a host does not stop existing between two builds.
    now += PROBE_RETRY_MS * 100;
    await expect(probePreviewHost(origin, { fetchImpl: up.fetchImpl, now: () => now })).resolves.toBe(true);
    expect(up.calls).toHaveLength(1);
  });
});

describe("preview host client — publishing a build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPreviewHostClient();
  });

  it("returns the hosted URL and says which origin is serving", async () => {
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "http://127.0.0.1:5174");
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("/health")
        ? responding(200, { ok: true })
        : responding(200, { ok: true, id: "b".repeat(32), path: `/p/${"b".repeat(32)}/` })
    );

    const outcome = await publishPreviewDocument(DOCUMENT, { fetchImpl });
    expect(outcome.hosted).toEqual({
      id: "b".repeat(32),
      // The preview's OWN origin, at its root: a router-based app needs the
      // root (see previewOrigin), and an origin no other preview shares is
      // what lets two chats show two apps at once.
      url: `http://${"b".repeat(32)}.localhost:5174/`,
      origin: `http://${"b".repeat(32)}.localhost:5174`,
    });
    expect(outcome.notice).toContain("its own origin");
    expect(isHostedPreviewUrl(outcome.hosted?.url)).toBe(true);

    const published = calls.find((c) => c.url.endsWith("/publish"))!;
    expect(published.init.method).toBe("POST");
    expect(published.init.body).toBe(DOCUMENT);
  });

  it("releases the previous build so old copies do not pile up", async () => {
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "http://127.0.0.1:5174");
    let next = 0;
    const { calls, fetchImpl } = recorder((url) => {
      if (url.endsWith("/health")) return responding(200, { ok: true });
      if (url.endsWith("/publish")) {
        const id = String(next++).padStart(32, "0");
        return responding(200, { ok: true, id, path: previewPath(id) });
      }
      return { ok: true, status: 204, json: async () => ({}), text: async () => "" } as unknown as Response;
    });

    await publishPreviewDocument(DOCUMENT, { fetchImpl });
    await publishPreviewDocument(DOCUMENT, { fetchImpl });

    const deleted = calls.filter((c) => c.init.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.url).toContain(`/p/${String(0).padStart(32, "0")}`);
  });

  it("gives each chat its own preview origin, and releases only its own", async () => {
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "http://127.0.0.1:5174");
    let next = 0;
    const { calls, fetchImpl } = recorder((url) => {
      if (url.endsWith("/health")) return responding(200, { ok: true });
      const id = String(next++).padStart(32, "0");
      return responding(200, { ok: true, id, path: previewPath(id) });
    });

    const a = await publishPreviewDocument(DOCUMENT, { fetchImpl, key: "chat-a" });
    const b = await publishPreviewDocument(DOCUMENT, { fetchImpl, key: "chat-b" });
    expect(a.hosted?.url).toBe(`http://${"0".repeat(32)}.localhost:5174/`);
    expect(b.hosted?.url).toBe(`http://${String(1).padStart(32, "0")}.localhost:5174/`);

    // Rebuilding chat A releases A's previous document and nothing else:
    // chat B is still framed and still on screen.
    await publishPreviewDocument("<html>a2</html>", { fetchImpl, key: "chat-a" });
    const deleted = calls.filter((c) => c.init.method === "DELETE").map((c) => c.url);
    expect(deleted).toHaveLength(1);
    // …and the DELETE is addressed to the HOST, not to the preview's origin,
    // which answers GET only.
    expect(deleted[0]).toBe(`http://127.0.0.1:5174/p/${"0".repeat(32)}`);
  });

  it("falls back to the inline document with a reason, never silently", async () => {
    // No host configured at all — no variable, and not a dev environment. In
    // that case nothing is even attempted: there is no URL that could exist.
    resetPreviewHostClient();
    vi.stubEnv("VITE_PREVIEW_ORIGIN", undefined);
    vi.stubEnv("DEV", undefined);
    const none = await publishPreviewDocument(DOCUMENT, {
      fetchImpl: (() => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    expect(none.hosted).toBeNull();
    expect(none.notice).toContain("VITE_PREVIEW_ORIGIN");

    // Configured, but nothing is listening.
    resetPreviewHostClient();
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "http://127.0.0.1:5174");
    const dead = recorder(() => {
      throw new Error("ECONNREFUSED");
    });
    const downOutcome = await publishPreviewDocument(DOCUMENT, { fetchImpl: dead.fetchImpl });
    expect(downOutcome.hosted).toBeNull();
    expect(downOutcome.notice).toContain("preview-host-server.ts");

    // Listening, but refusing this origin — the reason is passed through.
    resetPreviewHostClient();
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "http://127.0.0.1:5174");
    const refused = recorder((url) =>
      url.endsWith("/health")
        ? responding(200, { ok: true })
        : responding(403, { ok: false, error: "This origin may not publish previews." })
    );
    const refusedOutcome = await publishPreviewDocument(DOCUMENT, { fetchImpl: refused.fetchImpl });
    expect(refusedOutcome.hosted).toBeNull();
    expect(refusedOutcome.notice).toContain("403");

    // Listening and accepting, but answering something unusable.
    resetPreviewHostClient();
    const malformed = recorder((url) =>
      url.endsWith("/health") ? responding(200, { ok: true }) : responding(200, { ok: true })
    );
    const malformedOutcome = await publishPreviewDocument(DOCUMENT, { fetchImpl: malformed.fetchImpl });
    expect(malformedOutcome.hosted).toBeNull();
    expect(malformedOutcome.notice).toContain("no preview id");
  });

  it("says the same thing once, not on every rebuild", async () => {
    resetPreviewHostClient();
    const fallback = { hosted: null, notice: "No preview host answered." };
    expect(previewHostNotice(fallback)).toBe("No preview host answered.");
    expect(previewHostNotice(fallback)).toBeNull();
    expect(previewHostNotice({ hosted: null, notice: "A different reason." })).toBe("A different reason.");
  });
});

describe("preview host client — finding the host the dev server started", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPreviewHostClient();
  });

  it("asks the dev server which port its host got, instead of guessing", async () => {
    // The host walks upward when 5174 is busy, so the port is a fact only the
    // dev server has. Guessing meant "No preview host answered at
    // http://127.0.0.1:5174" while a host was running on 5177.
    vi.stubEnv("VITE_PREVIEW_ORIGIN", undefined);
    const { calls, fetchImpl } = recorder((url) => {
      if (url === PREVIEW_HOST_DISCOVERY_PATH) {
        return json(200, { origin: "http://127.0.0.1:5177", error: null });
      }
      if (url.endsWith("/health")) return json(200, { ok: true });
      return json(200, { ok: true, id: "c".repeat(32), path: previewPath("c".repeat(32)) });
    });

    const outcome = await publishPreviewDocument(DOCUMENT, { fetchImpl });
    const id = "c".repeat(32);
    expect(calls[0]!.url).toBe(PREVIEW_HOST_DISCOVERY_PATH);
    // The discovered host's own port is what the preview's origin carries.
    expect(outcome.hosted?.origin).toBe(`http://${id}.localhost:5177`);
    expect(outcome.hosted?.url).toBe(`http://${id}.localhost:5177/`);
  });

  it("keeps the discovered port for the session, so it costs one request", async () => {
    vi.stubEnv("VITE_PREVIEW_ORIGIN", undefined);
    const { calls, fetchImpl } = recorder((url) => {
      if (url === PREVIEW_HOST_DISCOVERY_PATH) return json(200, { origin: "http://127.0.0.1:5177" });
      if (url.endsWith("/health")) return json(200, { ok: true });
      return json(200, { ok: true, id: "e".repeat(32), path: previewPath("e".repeat(32)) });
    });

    await publishPreviewDocument(DOCUMENT, { fetchImpl });
    await publishPreviewDocument(DOCUMENT, { fetchImpl });
    expect(calls.filter((c) => c.url === PREVIEW_HOST_DISCOVERY_PATH)).toHaveLength(1);
  });

  it("is never a guess about a port someone configured", () => {
    vi.stubEnv("VITE_PREVIEW_ORIGIN", "https://preview.example.dev");
    expect(explicitPreviewHostOrigin()).toBe("https://preview.example.dev");
    expect(configuredPreviewHostOrigin({ DEV: true })).toBe(DEFAULT_PREVIEW_HOST_ORIGIN);
    // The default is NOT configuration: treating it as one is what would skip
    // discovery and then report a guessed port as a missing host.
    expect(explicitPreviewHostOrigin({ DEV: true })).toBeNull();
  });

  it("does not mistake a deployed app for a dev server", async () => {
    // A deployed single-page app answers ANY path with its index.html and a
    // 200. Reading that as "the host is on this origin" would point every
    // preview at the app's own origin and frame the app itself.
    vi.stubEnv("VITE_PREVIEW_ORIGIN", undefined);
    const { calls, fetchImpl } = recorder((url) => {
      if (url === PREVIEW_HOST_DISCOVERY_PATH) return html(200, "<!doctype html><div id=root>");
      if (url.endsWith("/health")) return json(200, { ok: true });
      return json(200, { ok: true, id: "f".repeat(32), path: previewPath("f".repeat(32)) });
    });

    const discovered = await discoverPreviewHost({ fetchImpl });
    expect(discovered).toEqual({ origin: null, error: null });

    resetPreviewHostClient();
    const outcome = await publishPreviewDocument(DOCUMENT, { fetchImpl });
    // The host is talked to at its own origin, and framed at the preview's.
    expect(calls.some((c) => c.url === `${DEFAULT_PREVIEW_HOST_ORIGIN}/health`)).toBe(true);
    expect(outcome.hosted?.origin).toBe(
      `http://${"f".repeat(32)}.localhost:5174`
    );
  });

  it("passes on the dev server's own reason when its host could not start", async () => {
    // "No preview host answered" is true and useless. The dev server knows
    // whether the port was busy, and that sentence is the one worth showing.
    vi.stubEnv("VITE_PREVIEW_ORIGIN", undefined);
    const { fetchImpl } = recorder((url) => {
      if (url === PREVIEW_HOST_DISCOVERY_PATH) {
        return json(200, { origin: null, error: "No free port in 5174–5185: every candidate is in use." });
      }
      throw new Error("ECONNREFUSED");
    });

    const outcome = await publishPreviewDocument(DOCUMENT, { fetchImpl });
    expect(outcome.hosted).toBeNull();
    expect(outcome.notice).toContain("every candidate is in use");
    expect(outcome.notice).toContain("preview-host-server.ts");
  });
});
