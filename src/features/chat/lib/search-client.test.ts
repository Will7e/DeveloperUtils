import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchWeb } from "./search-client";
import { capabilityState, resetAvailability } from "./availability";

const realFetch = globalThis.fetch;

beforeEach(() => resetAvailability());

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
  resetAvailability();
});

function stubFetch(response: Response | (() => Promise<Response>)) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? response() : response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOT_CONFIGURED = {
  code: "SEARCH_NOT_CONFIGURED",
  error: "Web search is not configured on this deployment.",
  providers: [
    { envVar: "TAVILY_API_KEY", label: "Tavily", freeTier: "1,000 searches/month free, no card", signupUrl: "https://tavily.com" },
    { envVar: "BRAVE_API_KEY", label: "Brave Search", freeTier: "$5 of monthly credit", signupUrl: "https://api-dashboard.search.brave.com" },
    { envVar: "EXA_API_KEY", label: "Exa", freeTier: "starter credit", signupUrl: "https://exa.ai" },
    { envVar: "SERPER_API_KEY", label: "Serper", freeTier: "2,500 one-time searches", signupUrl: "https://serper.dev" },
  ],
};

describe("searchWeb", () => {
  it("returns results with the provider that produced them", async () => {
    const calls = stubFetch(
      json({
        provider: "tavily",
        query: "react 19",
        results: [{ title: "React 19", url: "https://react.dev/blog", snippet: "Release notes." }],
      }),
    );

    const outcome = await searchWeb("react 19");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.provider).toBe("tavily");
    expect(outcome.results[0]?.url).toBe("https://react.dev/blog");
    expect(calls[0]?.url).toBe("/api/search");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("sends the query and the limit", async () => {
    const calls = stubFetch(json({ provider: "tavily", results: [] }));
    await searchWeb("  suspense  ", { limit: 3 });
    const body = JSON.parse(String(calls[0]?.init?.body)) as { query: string; limit: number };
    expect(body).toEqual({ query: "suspense", limit: 3 });
  });

  it("clamps a limit the endpoint would reject anyway", async () => {
    const calls = stubFetch(json({ provider: "tavily", results: [] }));
    await searchWeb("q", { limit: 500 });
    expect(JSON.parse(String(calls[0]?.init?.body)).limit).toBe(10);
    await searchWeb("q", { limit: 0 });
    expect(JSON.parse(String(calls[1]?.init?.body)).limit).toBe(1);
  });

  it("turns 'no key configured' into the exact setup step", async () => {
    // This is the message a user reads when they have done nothing wrong.
    stubFetch(json(NOT_CONFIGURED, 503));
    const outcome = await searchWeb("react 19");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.setupRequired).toBe(true);
    for (const envVar of ["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY", "SERPER_API_KEY"]) {
      expect(outcome.error).toContain(envVar);
    }
    expect(outcome.error).toContain("VITE_");
    expect(outcome.error).toContain(".env");
  });

  it("distinguishes a provider problem from a setup problem", async () => {
    stubFetch(json({ code: "SEARCH_PROVIDER_ERROR", provider: "tavily", error: "quota exceeded" }, 502));
    const outcome = await searchWeb("q");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.setupRequired).toBe(false);
    expect(outcome.error).toContain("quota exceeded");
    expect(outcome.error).toContain("502");
  });

  it("explains the endpoint being absent, which is what an unwired dev server looks like", async () => {
    // A route that does not exist returns the SPA's HTML, not JSON — and that
    // must not be mistaken for a search result set.
    stubFetch(new Response("<!doctype html><html><body>app</body></html>", { status: 200 }));
    const outcome = await searchWeb("q");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("non-JSON");
  });

  it("reports a refused origin as a routing problem, never as a missing key", async () => {
    // The confusing shape of "search is broken": the key is set, the route
    // exists, and the call is refused for who sent it. Telling the user to add
    // a key here would send them to fix the one thing that is fine.
    stubFetch(json({ code: "FORBIDDEN_ORIGIN", error: "This origin may not use the search endpoint." }, 403));
    const outcome = await searchWeb("q");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.setupRequired).toBe(false);
    expect(outcome.error).toContain("origin");
    expect(outcome.error).toContain("ask for the URL");
  });

  it("records an unreachable endpoint as observed-down for the next turn's note", async () => {
    // The note is how the model learns the consequence BEFORE it invents a URL:
    // "search is unavailable this turn — ask the user". A failure that is never
    // recorded is a failure the next turn repeats blind.
    stubFetch(json({ code: "FORBIDDEN_ORIGIN", error: "refused" }, 403));
    await searchWeb("q");
    expect(capabilityState("webSearch")).toBe("down");
  });

  it("returns the observed state to up when a search works", async () => {
    stubFetch(json({ code: "FORBIDDEN_ORIGIN", error: "refused" }, 403));
    await searchWeb("q");
    expect(capabilityState("webSearch")).toBe("down");

    stubFetch(json({ provider: "tavily", results: [] }));
    await searchWeb("q again");
    expect(capabilityState("webSearch")).toBe("up");
  });

  it("reports a transport failure without throwing", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const outcome = await searchWeb("q");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("did not answer");
  });

  it("reports an abort as an abort", async () => {
    stubFetch(() => Promise.reject(new DOMException("Aborted", "AbortError")));
    const controller = new AbortController();
    controller.abort();
    const outcome = await searchWeb("q", { signal: controller.signal });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe("Aborted by the user.");
  });

  it("refuses an empty query before spending a request", async () => {
    const calls = stubFetch(json({ results: [] }));
    const outcome = await searchWeb("   ");
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("treats a missing results array as no results, not as a crash", async () => {
    stubFetch(json({ provider: "tavily" }));
    const outcome = await searchWeb("q");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.results).toEqual([]);
  });
});
