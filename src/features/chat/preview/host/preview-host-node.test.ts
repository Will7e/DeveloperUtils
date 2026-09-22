// ============================================================
// Preview Host Node Adapter — On a Real Socket
// ============================================================
// The handler is tested as a pure function in ./preview-host.test.ts. What
// can only be tested HERE is everything that needs a socket and a process:
//
//   • the port walk. A host that cannot bind is not a loud failure — it is
//     the sandboxed fallback, which looks like "the preview is broken";
//   • that a GET is not answered with 413. That was a real bug, in this
//     adapter, invisible to unit tests of the handler: "no body" and "body
//     over the cap" were both `null`, so every GET was refused;
//   • that closing releases the port, because a dev server restarts.
//
// Real sockets, real ports, real fetch. Nothing here stubs the transport,
// which is the whole point of a separate file.
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { originFor, startPreviewHostServer, type RunningPreviewHost } from "./preview-host-node";

const APP_ORIGIN = "http://localhost:5173";
const DOCUMENT = "<!doctype html><html><body>served</body></html>";

const running: RunningPreviewHost[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  await Promise.all(
    blockers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

/** A port unlikely to be in use, so the test is not a coin flip */
function somePort(): number {
  return 41_000 + Math.floor(Math.random() * 9_000);
}

async function start(port: number, attempts = 4): Promise<RunningPreviewHost> {
  const host = await startPreviewHostServer({ port, portAttempts: attempts, allowedOrigins: [APP_ORIGIN] });
  running.push(host);
  return host;
}

/** Something else already listening on a port */
async function occupy(port: number): Promise<void> {
  const server = createServer((_req, res) => res.end("not the preview host"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  blockers.push(server);
}

async function publish(host: RunningPreviewHost): Promise<Response> {
  return fetch(`${host.origin}/publish`, {
    method: "POST",
    headers: { "Content-Type": "text/html; charset=utf-8", Origin: APP_ORIGIN },
    body: DOCUMENT,
  });
}

describe("preview host — binding", () => {
  it("walks to the next free port instead of leaving the preview without an origin", async () => {
    // The reported shape: the app itself, another checkout, or a second dev
    // server holds 5174. Giving up here is silent — the pane just loses its
    // origin and every preview runs sandboxed.
    const busy = somePort();
    await occupy(busy);

    const host = await start(busy);
    expect(host.port).toBe(busy + 1);
    expect(host.origin).toBe(originFor("127.0.0.1", busy + 1));
    await expect(fetch(`${host.origin}/health`).then((r) => r.json())).resolves.toMatchObject({
      ok: true,
    });
  });

  it("reports a nameable failure when every candidate port is taken", async () => {
    const first = somePort();
    await occupy(first);
    await occupy(first + 1);

    await expect(
      startPreviewHostServer({ port: first, portAttempts: 2, allowedOrigins: [APP_ORIGIN] })
    ).rejects.toThrow(/No free port in /);
  });

  it("releases the port when it closes, so a restarted dev server can rebind", async () => {
    const port = somePort();
    const host = await start(port);
    await host.close();
    running.length = 0;

    const again = await start(port);
    expect(again.port).toBe(port);
  });
});

describe("preview host — serving over the socket", () => {
  it("answers a GET with the document, not with a size refusal", async () => {
    // The adapter bug, pinned: in a request with no body, "nothing to read"
    // and "over the cap" were the same value, and the size rule was applied
    // to reads that never happened. Every GET — including the health probe
    // and the document itself — came back 413.
    const host = await start(somePort());
    const health = await fetch(`${host.origin}/health`);
    expect(health.status).toBe(200);

    const published = await publish(host);
    expect(published.status).toBe(200);

    const served = await fetch(host.origin);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(DOCUMENT);
  });

  it("serves the policy that keeps the preview's origin, over a real connection", async () => {
    const host = await start(somePort());
    await publish(host);
    const served = await fetch(host.origin);
    const policy = served.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("sandbox allow-scripts allow-same-origin");
    expect(policy).toContain(`frame-ancestors ${APP_ORIGIN}`);
    // No CORS on the document itself: the user's source is not readable by
    // another page that happens to know the URL.
    expect(served.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows only the publishing origin to read a publish response", async () => {
    const host = await start(somePort());
    const res = await publish(host);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);

    const refused = await fetch(`${host.origin}/publish`, {
      method: "POST",
      headers: { "Content-Type": "text/html; charset=utf-8", Origin: "https://evil.example" },
      body: DOCUMENT,
    });
    expect(refused.status).toBe(403);
  });

  it("takes a document up to the cap and refuses one past it", async () => {
    const port = somePort();
    const host = await startPreviewHostServer({
      port,
      allowedOrigins: [APP_ORIGIN],
      maxDocumentBytes: 64,
    });
    running.push(host);

    const tooBig = await fetch(`${host.origin}/publish`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
      body: "x".repeat(200),
    });
    expect(tooBig.status).toBe(413);
  });
});

describe("preview host — origins", () => {
  it("brackets a bare IPv6 host and leaves the usual loopback alone", () => {
    expect(originFor("127.0.0.1", 5174)).toBe("http://127.0.0.1:5174");
    expect(originFor("localhost", 5174)).toBe("http://localhost:5174");
    expect(originFor("::1", 5174)).toBe("http://[::1]:5174");
  });
});
