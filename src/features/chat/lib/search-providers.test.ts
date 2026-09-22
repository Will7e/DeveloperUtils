// ============================================================
// Search Providers — The Contracts, Pinned Before A Key Exists
// ============================================================
// These are the tests that make "paste any key and it works" true. A wrong
// header or a renamed response field is invisible until someone finally
// sets a key, and then it fails in production as an empty result list —
// which reads to the model as "the web has no answer". Each provider's real
// request shape and a real response fixture are pinned here instead.
// ============================================================

import { describe, expect, it } from "vitest";

import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_ENV,
  cleanSnippet,
  normalizeResults,
  pickProvider,
  searchEnvVars,
  type SearchProvider,
} from "./search-providers";

const provider = (id: string): SearchProvider => {
  const found = SEARCH_PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`no provider ${id}`);
  return found;
};

describe("provider request contracts", () => {
  it("Tavily posts JSON with a bearer token", () => {
    const tavily = provider("tavily");
    expect(tavily.method).toBe("POST");
    expect(tavily.url("q", 5)).toBe("https://api.tavily.com/search");
    expect(tavily.headers("tvly-x").Authorization).toBe("Bearer tvly-x");
    expect(JSON.parse(tavily.body("react 19 changes", 5))).toMatchObject({
      query: "react 19 changes",
      max_results: 5,
    });
  });

  it("Brave GETs with the query in the URL and its own header", () => {
    const brave = provider("brave");
    expect(brave.method).toBe("GET");
    expect(brave.url("react suspense", 4)).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=react%20suspense&count=4",
    );
    expect(brave.headers("brave-x")["X-Subscription-Token"]).toBe("brave-x");
    expect(brave.body("q", 5)).toBe("");
  });

  it("Exa posts with x-api-key", () => {
    const exa = provider("exa");
    expect(exa.url("q", 5)).toBe("https://api.exa.ai/search");
    expect(exa.headers("exa-x")["x-api-key"]).toBe("exa-x");
    expect(JSON.parse(exa.body("q", 3))).toMatchObject({ query: "q", numResults: 3 });
  });

  it("Serper posts with X-API-KEY and its own field name", () => {
    const serper = provider("serper");
    expect(serper.url("q", 5)).toBe("https://google.serper.dev/search");
    expect(serper.headers("s-x")["X-API-KEY"]).toBe("s-x");
    expect(JSON.parse(serper.body("q", 2))).toMatchObject({ q: "q", num: 2 });
  });

  it("never asks a provider for a written answer instead of results", () => {
    // A generated answer is a claim about pages the agent has not read.
    for (const p of SEARCH_PROVIDERS) {
      if (!p.body("q", 5)) continue;
      const parsed = JSON.parse(p.body("q", 5)) as Record<string, unknown>;
      expect(parsed.include_answer ?? false, p.id).toBe(false);
    }
  });
});

describe("provider response parsing", () => {
  it("reads Tavily's results", () => {
    const results = provider("tavily").parse({
      query: "q",
      results: [
        { title: "React 19", url: "https://react.dev/blog", content: "The release notes.", score: 0.9 },
      ],
    });
    expect(results).toEqual([
      { title: "React 19", url: "https://react.dev/blog", snippet: "The release notes." },
    ]);
  });

  it("reads Brave's results from its nested shape", () => {
    const results = provider("brave").parse({
      web: {
        results: [
          {
            title: "Suspense &amp; You",
            url: "https://example.com/suspense",
            description: "Use <strong>suspense</strong> to&hellip; wait.",
          },
        ],
      },
    });
    expect(results).toEqual([
      {
        title: "Suspense &amp; You",
        url: "https://example.com/suspense",
        snippet: "Use <strong>suspense</strong> to&hellip; wait.",
      },
    ]);

    // Parsing is raw by design; one normalisation pass cleans BOTH fields,
    // so the markup Brave adds around matched terms never reaches the model.
    const [normalized] = normalizeResults(results, 5);
    expect(normalized).toEqual({
      title: "Suspense & You",
      url: "https://example.com/suspense",
      snippet: "Use suspense to… wait.",
    });
  });

  it("reads Exa's results from its text field", () => {
    const results = provider("exa").parse({
      results: [{ title: "Docs", url: "https://docs.example.com/x", text: "Page text here." }],
    });
    expect(results[0]?.snippet).toBe("Page text here.");
  });

  it("reads Serper's organic results from its link field", () => {
    const results = provider("serper").parse({
      organic: [{ title: "SO", link: "https://stackoverflow.com/q/1", snippet: "An answer." }],
    });
    expect(results[0]?.url).toBe("https://stackoverflow.com/q/1");
  });

  it("returns nothing rather than throwing on a shape it does not recognise", () => {
    // A provider changing its payload, or an error body arriving with a 200,
    // must not crash the tool — an empty list is reported as no results.
    for (const p of SEARCH_PROVIDERS) {
      expect(p.parse({}), p.id).toEqual([]);
      expect(p.parse({ results: "not an array" }), p.id).toEqual([]);
      expect(p.parse(null), p.id).toEqual([]);
      expect(p.parse([]), p.id).toEqual([]);
    }
  });

  it("skips individual entries with missing fields instead of inventing them", () => {
    const results = provider("serper").parse({
      organic: [{ title: "no url" }, { link: "https://example.com/ok", snippet: "fine" }],
    });
    expect(results).toHaveLength(2);
    // The title falls back to the URL at normalize time; the url-less entry
    // is dropped there for being unfetchable.
    expect(normalizeResults(results, 5).map((r) => r.url)).toEqual(["https://example.com/ok"]);
  });
});

describe("normalizeResults", () => {
  const hit = (url: string, title = "T") => ({ title, url, snippet: "S" });

  it("drops anything the fetch tool could not then open", () => {
    // A result the agent cannot read is worse than no result: it looks like
    // an answer and cannot be followed.
    const results = normalizeResults(
      [
        hit("https://example.com/a"),
        hit("mailto:x@example.com"),
        hit("javascript:alert(1)"),
        hit("/relative/path"),
        hit("http://127.0.0.1:9999/admin"),
        hit("http://169.254.169.254/latest/meta-data/"),
      ],
      10,
    );
    expect(results.map((r) => r.url)).toEqual(["https://example.com/a"]);
  });

  it("collapses the same page found twice", () => {
    const results = normalizeResults(
      [hit("https://example.com/docs"), hit("http://example.com/docs/"), hit("https://example.com/docs#section")],
      10,
    );
    expect(results).toHaveLength(2);
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 20 }, (_v, i) => hit(`https://example.com/${i}`));
    expect(normalizeResults(many, 3)).toHaveLength(3);
  });

  it("falls back to the URL when a result has no title", () => {
    const results = normalizeResults([{ title: "  ", url: "https://example.com/x", snippet: "" }], 5);
    expect(results[0]?.title).toBe("https://example.com/x");
  });
});

describe("cleanSnippet", () => {
  it("removes markup, decodes entities and collapses whitespace", () => {
    expect(cleanSnippet("<b>Hello</b>\n\n &amp; welcome   here")).toBe("Hello & welcome here");
  });

  it("caps a provider that returns a paragraph", () => {
    expect(cleanSnippet("x".repeat(1000)).length).toBe(400);
  });
});

describe("pickProvider", () => {
  const configured = (...vars: string[]) => (envVar: string) => vars.includes(envVar);

  it("prefers the most generous free tier when several keys are set", () => {
    // Tavily first: 1,000 searches/month with no card.
    const picked = pickProvider(configured("SERPER_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY"));
    expect(picked?.id).toBe("tavily");
  });

  it("uses whichever single key is present", () => {
    expect(pickProvider(configured("SERPER_API_KEY"))?.id).toBe("serper");
    expect(pickProvider(configured("EXA_API_KEY"))?.id).toBe("exa");
    expect(pickProvider(configured("BRAVE_API_KEY"))?.id).toBe("brave");
  });

  it("returns null when nothing is configured, which the tool reports as a setup step", () => {
    expect(pickProvider(configured())).toBeNull();
  });

  it("honours an explicit override", () => {
    const picked = pickProvider(configured("TAVILY_API_KEY", "SERPER_API_KEY"), "serper");
    expect(picked?.id).toBe("serper");
    expect(pickProvider(configured("TAVILY_API_KEY"), "serper")?.id).toBe("tavily");
  });

  it("ignores an override naming a provider with no key, rather than failing closed", () => {
    expect(pickProvider(configured("TAVILY_API_KEY"), "exa")?.id).toBe("tavily");
  });

  it("names every key that can enable search, for the setup message", () => {
    const vars = searchEnvVars().map((p) => p.envVar);
    expect(vars).toEqual(["TAVILY_API_KEY", "BRAVE_API_KEY", "EXA_API_KEY", "SERPER_API_KEY"]);
    expect(SEARCH_PROVIDER_ENV).toBe("SEARCH_PROVIDER");
  });
});
