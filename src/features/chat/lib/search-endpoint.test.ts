// ============================================================
// Search Endpoint — Verified Without A Key
// ============================================================
// This is what makes "paste a key and it works" a testable claim rather
// than a hope. Every provider is reached through a stubbed fetch, so the
// dispatch, the error mapping, the redaction and the throttle are all
// exercised here — the only thing left unverified is the remote service
// itself, which no amount of local testing can cover.
// ============================================================

import { afterEach, describe, expect, it } from "vitest";

import {
  handleSearchRequest,
  isAllowedSearchOrigin,
  resetSearchRateLimit,
  type SearchEndpointDeps,
} from "./search-endpoint";

afterEach(() => {
  resetSearchRateLimit();
});

interface StubOptions {
  status?: number;
  payload?: unknown;
  body?: string;
  throw?: Error;
}

function stubFetch(options: StubOptions = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (options.throw) throw options.throw;
    if (options.body !== undefined) {
      return new Response(options.body, { status: options.status ?? 200 });
    }
    return new Response(JSON.stringify(options.payload ?? {}), {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const tavilyPayload = {
  results: [
    { title: "React 19", url: "https://react.dev/blog/react-19", content: "Release notes for React 19." },
    { title: "Duplicate", url: "https://react.dev/blog/react-19", content: "same page" },
    { title: "Local", url: "http://127.0.0.1:3000/admin", content: "should be dropped" },
  ],
};

const call = (query: unknown, limit: unknown, deps: Omit<SearchEndpointDeps, "clientKey">) =>
  handleSearchRequest(query, limit, { ...deps, clientKey: "test" });

describe("handleSearchRequest", () => {
  it("is a setup step, not an error, when no key is configured", async () => {
    const res = await call("react 19", 5, { env: {} });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SEARCH_NOT_CONFIGURED");
    // The message has to name every option and where the key comes from,
    // because this is the text the user acts on.
    const hint = res.body.hint ?? "";
    for (const envVar of ["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY", "SERPER_API_KEY"]) {
      expect(hint).toContain(envVar);
    }
    expect(hint).toContain("VITE_");
  });

  it("uses whichever key is present and never returns it", async () => {
    const { fetchImpl, calls } = stubFetch({ payload: tavilyPayload });
    const res = await call("react 19", 5, {
      env: { TAVILY_API_KEY: "tvly-secret-value" },
      fetchImpl,
    });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("tavily");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tvly-secret-value",
    );
    // The credential belongs in the request, nowhere in the response.
    expect(JSON.stringify(res.body)).not.toContain("tvly-secret-value");
  });

  it("returns clean, deduped, openable results and drops the unfetchable ones", async () => {
    const { fetchImpl } = stubFetch({ payload: tavilyPayload });
    const res = await call("react 19", 5, { env: { TAVILY_API_KEY: "k" }, fetchImpl });

    expect(res.body.results).toEqual([
      { title: "React 19", url: "https://react.dev/blog/react-19", snippet: "Release notes for React 19." },
    ]);
  });

  it("honours the limit, including a hostile one", async () => {
    const many = {
      results: Array.from({ length: 30 }, (_v, i) => ({
        title: `T${i}`,
        url: `https://example.com/${i}`,
        content: "c",
      })),
    };
    const { fetchImpl } = stubFetch({ payload: many });
    const res = await call("q", 9999, { env: { TAVILY_API_KEY: "k" }, fetchImpl });
    expect(res.body.results?.length).toBe(10);
  });

  it("redacts the key if a provider echoes it in an error", async () => {
    const { fetchImpl } = stubFetch({
      status: 401,
      body: '{"error":"invalid key tvly-secret-value"}',
    });
    const res = await call("q", 5, { env: { TAVILY_API_KEY: "tvly-secret-value" }, fetchImpl });

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("***");
    expect(JSON.stringify(res.body)).not.toContain("tvly-secret-value");
  });

  it("passes a provider's own status text through, because the fixes differ", async () => {
    const { fetchImpl } = stubFetch({ status: 429, body: "quota exceeded" });
    const res = await call("q", 5, { env: { TAVILY_API_KEY: "k" }, fetchImpl });
    expect(res.body.error).toContain("quota exceeded");
  });

  it("reports a provider that never answers as a timeout, not a hang", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const { fetchImpl } = stubFetch({ throw: abort });
    const res = await call("q", 5, { env: { TAVILY_API_KEY: "k" }, fetchImpl });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("did not answer");
  });

  it("rejects an empty or oversized query before spending a request", async () => {
    const { fetchImpl, calls } = stubFetch({ payload: tavilyPayload });
    expect((await call("   ", 5, { env: { TAVILY_API_KEY: "k" }, fetchImpl })).status).toBe(400);
    expect((await call("x".repeat(501), 5, { env: { TAVILY_API_KEY: "k" }, fetchImpl })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses an origin that is not this app", async () => {
    const { fetchImpl, calls } = stubFetch({ payload: tavilyPayload });
    const res = await call("q", 5, {
      env: { TAVILY_API_KEY: "k" },
      fetchImpl,
      origin: "https://evil.example.com",
      host: "intab.example.com",
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("accepts a same-origin call on a domain nobody wrote down", async () => {
    // The failure this pins: the app deployed on its own domain called its own
    // endpoint, the hard-coded allowlist did not name that domain, and search
    // answered 403 while the provider key was perfectly configured.
    const { fetchImpl, calls } = stubFetch({ payload: tavilyPayload });
    const res = await call("q", 5, {
      env: { TAVILY_API_KEY: "k" },
      fetchImpl,
      origin: "https://tools.acme.example",
      host: "tools.acme.example",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("matches the request host regardless of port or www", async () => {
    const { fetchImpl } = stubFetch({ payload: tavilyPayload });
    const withPort = await call("q", 5, {
      env: { TAVILY_API_KEY: "k" },
      fetchImpl,
      origin: "http://localhost:5199",
      host: "localhost:5199",
    });
    expect(withPort.status).toBe(200);
    const www = await call("q", 5, {
      env: { TAVILY_API_KEY: "k" },
      fetchImpl,
      origin: "https://www.acme.example",
      host: "acme.example",
    });
    expect(www.status).toBe(200);
  });

  it("does not let a missing Host header widen the allowlist", async () => {
    const { fetchImpl } = stubFetch({ payload: tavilyPayload });
    const res = await call("q", 5, {
      env: { TAVILY_API_KEY: "k" },
      fetchImpl,
      origin: "https://evil.example.com",
      host: null,
    });
    expect(res.status).toBe(403);
  });

  it("throttles a client that spends the quota in a loop", async () => {
    const { fetchImpl } = stubFetch({ payload: tavilyPayload });
    const env = { TAVILY_API_KEY: "k" };
    let last = 0;
    for (let i = 0; i < 25; i++) {
      const res = await call(`q${i}`, 5, { env, fetchImpl });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("lets a different client through the same window", async () => {
    const { fetchImpl } = stubFetch({ payload: tavilyPayload });
    const env = { TAVILY_API_KEY: "k" };
    for (let i = 0; i < 25; i++) await handleSearchRequest("q", 5, { clientKey: "noisy", env, fetchImpl });
    const res = await handleSearchRequest("q", 5, { clientKey: "quiet", env, fetchImpl });
    expect(res.status).toBe(200);
  });

  it("switches providers when SEARCH_PROVIDER says so", async () => {
    const { fetchImpl, calls } = stubFetch({
      payload: { organic: [{ title: "SO", link: "https://stackoverflow.com/q/1", snippet: "answer" }] },
    });
    const res = await call("q", 5, {
      env: { TAVILY_API_KEY: "k", SERPER_API_KEY: "s", SEARCH_PROVIDER: "serper" },
      fetchImpl,
    });

    expect(res.body.provider).toBe("serper");
    expect(calls[0]?.url).toBe("https://google.serper.dev/search");
    expect(res.body.results?.[0]?.url).toBe("https://stackoverflow.com/q/1");
  });

  it("reports an unreadable provider payload as no results rather than a crash", async () => {
    const { fetchImpl } = stubFetch({ body: "<html>gateway error</html>" });
    const res = await call("q", 5, { env: { TAVILY_API_KEY: "k" }, fetchImpl });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("uses the GET verb for Brave, with the query in the URL", async () => {
    const { fetchImpl, calls } = stubFetch({ payload: { web: { results: [] } } });
    await call("react suspense", 3, { env: { BRAVE_API_KEY: "b" }, fetchImpl });
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.url).toContain("count=3");
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});

describe("isAllowedSearchOrigin", () => {
  const env = {};

  it("allows the app's own origins and local dev", () => {
    for (const origin of [
      "https://in-tab.se",
      "https://app.intab.dev",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://staging.intab.dev",
    ]) {
      expect(isAllowedSearchOrigin(origin, env), origin).toBe(true);
    }
  });

  it("allows a missing Origin header, which non-browser clients omit", () => {
    expect(isAllowedSearchOrigin(null, env)).toBe(true);
    expect(isAllowedSearchOrigin(undefined, env)).toBe(true);
  });

  it("refuses lookalike and third-party origins", () => {
    for (const origin of [
      "https://in-tab.se.evil.com",
      "https://evil-in-tab.se",
      "https://example.com",
      "not a url",
    ]) {
      expect(isAllowedSearchOrigin(origin, env), origin).toBe(false);
    }
  });

  it("allows the Vercel deployment hosts from the environment", () => {
    const vercelEnv = { VERCEL_PROJECT_PRODUCTION_URL: "intab.vercel.app" };
    expect(isAllowedSearchOrigin("https://intab.vercel.app", vercelEnv)).toBe(true);
    expect(isAllowedSearchOrigin("https://preview-abc.intab.vercel.app", vercelEnv)).toBe(true);
  });

  it("allows a same-origin call against the request's own host", () => {
    expect(
      isAllowedSearchOrigin("https://tools.acme.example", {}, "tools.acme.example")
    ).toBe(true);
    // The Origin's own host is what is compared — a lookalike does not become
    // same-origin by sitting next to the real host.
    expect(
      isAllowedSearchOrigin("https://evil.com", {}, "tools.acme.example")
    ).toBe(false);
  });
});
