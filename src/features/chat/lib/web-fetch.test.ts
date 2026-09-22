import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWebDocument } from "./web-fetch";

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string) => Promise<Response>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return impl(url);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });

describe("fetchWebDocument", () => {
  it("reads a page directly when the server permits it", async () => {
    const calls = stubFetch(async () => html("<html><body>Direct</body></html>"));
    const result = await fetchWebDocument("https://example.com/docs");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain("Direct");
    expect(result.viaProxy).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://example.com/docs");
  });

  it("falls back to the relay when CORS refuses the direct fetch", async () => {
    // The ordinary case: a public page whose server sends no ACAO header.
    const calls = stubFetch(async (url) => {
      if (url.startsWith("/api/proxy")) {
        return html("<html><body>Relayed</body></html>", { "access-control-allow-origin": "*" });
      }
      throw new TypeError("Failed to fetch");
    });

    const result = await fetchWebDocument("https://docs.example.org/guide");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain("Relayed");
    expect(result.viaProxy).toBe(true);
    expect(calls[1]).toContain(encodeURIComponent("https://docs.example.org/guide"));
  });

  it("names both failures when neither path answers", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await fetchWebDocument("https://blocked.example.com/");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("https://blocked.example.com/");
    expect(result.error).toContain("Failed to fetch");
  });

  it("refuses metadata, loopback and private hosts without making a request", async () => {
    const calls = stubFetch(async () => html("should never be reached"));

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:5174/admin",
      "http://localhost/secrets",
      "http://10.0.0.5/internal",
      "http://192.168.1.1/router",
    ]) {
      const result = await fetchWebDocument(url);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatch(/Refused/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses non-http schemes before any request", async () => {
    const calls = stubFetch(async () => html("nope"));
    const result = await fetchWebDocument("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("http(s)");
    expect(calls).toHaveLength(0);
  });

  it("does not mistake the app's own shell for the requested page", async () => {
    // A dev server's SPA fallback: 200, HTML, no relay CORS header. Without
    // this check the model is handed this app as "the page you asked for".
    stubFetch(async (url) => {
      if (url.startsWith("/api/proxy")) {
        return html(`<!doctype html><script type="module" src="/@vite/client"></script><div id="root"></div>`);
      }
      throw new TypeError("Failed to fetch");
    });

    const result = await fetchWebDocument("https://example.com/");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("relay did not answer");
  });

  it("stops reading at the byte cap and says so", async () => {
    const big = "x".repeat(5000);
    stubFetch(async () => html(big));

    const result = await fetchWebDocument("https://example.com/big", { maxBytes: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toHaveLength(1000);
  });

  it("reports a redirect that moved the target", async () => {
    stubFetch(async () => {
      const res = html("<html><body>Final</body></html>");
      // A followed redirect is what `res.url` reflects.
      Object.defineProperty(res, "url", { value: "https://example.com/real" });
      return res;
    });

    const result = await fetchWebDocument("https://t.co/short");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redirectNote).toBe("Redirected to https://example.com/real");
  });

  it("reports an abort as an abort, not as a network failure", async () => {
    stubFetch(async () => {
      throw new DOMException("Aborted", "AbortError");
    });

    const controller = new AbortController();
    controller.abort();
    const result = await fetchWebDocument("https://example.com/", { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Aborted by the user.");
  });

  it("passes a non-2xx status through with its body, because a 404 page is evidence", async () => {
    stubFetch(async () => new Response("<html><body>Not found</body></html>", { status: 404, headers: { "content-type": "text/html" } }));
    const result = await fetchWebDocument("https://example.com/missing");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(404);
    expect(result.body).toContain("Not found");
  });
});
