// ============================================================
// Endpoints cache — one request per model, not one per render
// ============================================================
// The hook that reads this runs in the chat header, which re-renders on every
// streaming chunk. So the difference between "cached" and "not cached" here is
// the difference between one request per model and dozens per reply — and the
// second one is a rate limit, not a slowdown.
//
// The failure paths matter as much as the happy one: serving facts are worth
// showing and never worth failing a turn over, so an error must resolve to null
// (the card then says nothing) rather than throw into a render.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureModelEndpoints, getCachedEndpoints, resetEndpointsCache } from "./model-catalog";

const ENDPOINTS_BODY = {
  data: {
    id: "openai/gpt-6-luna-pro",
    endpoints: [
      {
        provider_name: "OpenAI",
        tag: "openai/flex",
        pricing: { prompt: "0.00000005", completion: "0.00000025" },
        supported_parameters: ["tools"],
        supports_implicit_caching: true,
      },
      {
        provider_name: "Azure",
        tag: "azure",
        pricing: { prompt: "0.0000001", completion: "0.00000025" },
        supported_parameters: ["tools"],
      },
    ],
  },
};

/** Stubs fetch, counting calls and returning whatever `handler` decides */
function stubFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetEndpointsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureModelEndpoints", () => {
  it("requests the model's endpoints once and reuses the answer", async () => {
    const calls = stubFetch(() => jsonResponse(ENDPOINTS_BODY));
    const first = await ensureModelEndpoints("key", "openai/gpt-6-luna-pro");
    const second = await ensureModelEndpoints("key", "openai/gpt-6-luna-pro");

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(getCachedEndpoints("openai/gpt-6-luna-pro")).toEqual(first);
  });

  it("does not encode the slash that is the route's structure", async () => {
    // `encodeURIComponent` turns this into `openai%2Fgpt-6-luna-pro`, the path
    // route stops matching, and the API answers with an empty endpoint list
    // instead of an error — the exact failure the probe caught.
    const calls = stubFetch(() => jsonResponse(ENDPOINTS_BODY));
    await ensureModelEndpoints("key", "openai/gpt-6-luna-pro");
    expect(calls[0]).toContain("/models/openai/gpt-6-luna-pro/endpoints");
    expect(calls[0]).not.toContain("%2F");
  });

  it("coalesces concurrent callers onto one request", async () => {
    // Two renders of the same model must not become two requests.
    let resolve: ((res: Response) => void) | null = null;
    const calls = stubFetch(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        })
    );
    const a = ensureModelEndpoints("key", "vendor/model");
    const b = ensureModelEndpoints("key", "vendor/model");
    resolve!(jsonResponse(ENDPOINTS_BODY));
    const [first, second] = await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it("resolves null on failure and does not cache the failure", async () => {
    const calls = stubFetch(() => jsonResponse({ error: { message: "nope" } }, 500));
    expect(await ensureModelEndpoints("key", "vendor/model")).toBeNull();
    expect(getCachedEndpoints("vendor/model")).toBeNull();
    // A second attempt is a second request: a provider that was briefly
    // unreachable must not be remembered as having no endpoints.
    await ensureModelEndpoints("key", "vendor/model");
    expect(calls).toHaveLength(2);
  });

  it("does not cache an empty endpoint list", async () => {
    // An empty list means the route matched nothing; holding it for ten minutes
    // would keep reporting "nobody serves this" after the answer was available.
    let body: unknown = { data: { id: "vendor/model", endpoints: [] } };
    stubFetch(() => jsonResponse(body));
    expect(await ensureModelEndpoints("key", "vendor/model")).toBeNull();
    expect(getCachedEndpoints("vendor/model")).toBeNull();

    body = ENDPOINTS_BODY;
    const recovered = await ensureModelEndpoints("key", "vendor/model");
    expect(recovered?.providers).toBe(2);
  });

  it("keeps models apart", async () => {
    const calls = stubFetch(() => jsonResponse(ENDPOINTS_BODY));
    await ensureModelEndpoints("key", "vendor/one");
    await ensureModelEndpoints("key", "vendor/two");
    expect(calls).toHaveLength(2);
    expect(getCachedEndpoints("vendor/one")).not.toBeNull();
    expect(getCachedEndpoints("vendor/two")).not.toBeNull();
  });

  it("expires the answer rather than trusting it forever", async () => {
    // Uptime and latency inside it are rolling windows, so the TTL is minutes.
    const calls = stubFetch(() => jsonResponse(ENDPOINTS_BODY));
    await ensureModelEndpoints("key", "vendor/model");
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    try {
      expect(getCachedEndpoints("vendor/model")).toBeNull();
      await ensureModelEndpoints("key", "vendor/model");
      expect(calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("has nothing to say about a model it was never asked about", () => {
    expect(getCachedEndpoints("vendor/unknown")).toBeNull();
    expect(getCachedEndpoints(undefined)).toBeNull();
  });
});
