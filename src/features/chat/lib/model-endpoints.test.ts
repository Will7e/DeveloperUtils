// ============================================================
// Model Endpoints — Tests
// ============================================================
// Two kinds of case here, and the difference is deliberate:
//
//   • the CAPTURED fixture (`__fixtures__/endpoints.json`, written by
//     `npm run probe:openrouter --fixtures`) proves the parser reads the shape
//     the API really returns — including the nulls it returns for a provider
//     that has no uptime to report;
//   • hand-built records cover the states the capture does not contain (no
//     endpoint declaring tools, a single provider, an unpriced endpoint), since
//     those are the states the notes exist to describe and a live capture cannot
//     be asked to produce them on demand.

import { describe, it, expect } from "vitest";
import { endpointNotes, parseEndpointRecords, summarizeEndpoints } from "./model-endpoints";
import type { ModelEndpointInfo } from "../types";
import captured from "./__fixtures__/endpoints.json";

const fixture = parseEndpointRecords(captured);

function endpoint(over: Partial<ModelEndpointInfo> & { providerName: string }): ModelEndpointInfo {
  return { ...over };
}

describe("parseEndpointRecords — against the captured response", () => {
  it("keeps the endpoint records and drops nothing that matters", () => {
    expect(fixture.length).toBe(captured.data.endpoints.length);
    for (const e of fixture) {
      expect(e.providerName).toBeTruthy();
      expect(e.promptPrice).toBeGreaterThan(0);
      expect(e.completionPrice).toBeGreaterThan(0);
    }
  });

  it("converts per-token prices to the per-million figures the app compares", () => {
    // The wire sends "0.00000005" (USD per token). Everything in this app — the
    // picker badges, the cost meter, the escalation ceiling — is per million, so
    // a parser that left the raw figure would understate every price by 1e6.
    const first = fixture[0]!;
    const raw = Number(captured.data.endpoints[0]!.pricing.prompt);
    expect(first.promptPrice).toBeCloseTo(raw * 1_000_000, 10);
    expect(first.promptPrice).toBeLessThan(10);
  });

  it("keeps a null uptime absent rather than zero", () => {
    // Zero uptime would read as "this provider is down", which is a different
    // and much louder claim than "no measurement was reported".
    const nulls = captured.data.endpoints.filter((e) => e.uptime_last_30m === null);
    expect(nulls.length).toBeGreaterThan(0);
    for (const raw of nulls) {
      const parsed = fixture.find((e) => e.providerName === raw.provider_name && e.tag === raw.tag)!;
      expect(parsed.uptimeLast30m).toBeUndefined();
    }
  });

  it("omits an uninformative quantization string", () => {
    // "unknown" is the API's way of saying nothing, and a badge reading
    // "quantization: unknown" would imply a measurement nobody made.
    const raw = captured.data.endpoints[0]!;
    expect(raw.quantization).toBe("unknown");
    expect(fixture[0]!.quantization).toBeUndefined();
  });

  it("drops a record with no provider name instead of counting an anonymous one", () => {
    const parsed = parseEndpointRecords({
      data: { id: "x/y", endpoints: [{ provider_name: "  " }, { provider_name: "Real" }] },
    });
    expect(parsed.map((e) => e.providerName)).toEqual(["Real"]);
  });

  it("returns nothing for a malformed or empty payload", () => {
    expect(parseEndpointRecords(undefined)).toEqual([]);
    expect(parseEndpointRecords({})).toEqual([]);
    expect(parseEndpointRecords({ data: {} })).toEqual([]);
  });
});

describe("summarizeEndpoints — against the captured response", () => {
  const summary = summarizeEndpoints(fixture);

  it("counts providers and endpoints separately", () => {
    // The capture has two providers serving five endpoints (service tiers), and
    // conflating the two would either overstate the failover options or hide
    // them.
    expect(summary.providers).toBe(new Set(fixture.map((e) => e.providerName)).size);
    expect(summary.endpoints).toBe(fixture.length);
    expect(summary.providers).toBeLessThan(summary.endpoints);
  });

  it("names the cheapest endpoint and the measured spread", () => {
    expect(summary.cheapest?.promptPrice).toBe(Math.min(...fixture.map((e) => e.promptPrice!)));
    // The capture's real spread: the same model served at more than double the
    // price from a different endpoint of the same provider.
    expect(summary.priceSpread).toBeGreaterThan(1);
  });

  it("reports the quickest measured p50, not an average of endpoints", () => {
    expect(summary.fastestP50Ms).toBe(Math.min(...fixture.map((e) => e.latencyP50!)));
  });

  it("counts tool support per endpoint, which is what the router filters on", () => {
    expect(summary.toolEndpoints).toBe(
      fixture.filter((e) => e.supportedParameters?.includes("tools")).length
    );
    expect(summary.toolEndpoints).toBeGreaterThan(0);
  });

  it("keeps a two-provider model from claiming a spread when nothing is priced", () => {
    const summary2 = summarizeEndpoints([
      endpoint({ providerName: "a" }),
      endpoint({ providerName: "b" }),
    ]);
    expect(summary2.providers).toBe(2);
    expect(summary2.cheapest).toBeUndefined();
    expect(summary2.priceSpread).toBeUndefined();
    expect(summary2.fastestP50Ms).toBeUndefined();
  });

  it("does not report a spread when every endpoint charges the same", () => {
    const summary3 = summarizeEndpoints([
      endpoint({ providerName: "a", promptPrice: 2 }),
      endpoint({ providerName: "b", promptPrice: 2 }),
    ]);
    expect(summary3.priceSpread).toBeUndefined();
  });

  it("summarizes an empty list without inventing anything", () => {
    const empty = summarizeEndpoints([]);
    expect(empty).toMatchObject({
      providers: 0,
      endpoints: 0,
      toolEndpoints: 0,
      implicitCachingEndpoints: 0,
      cachePricedEndpoints: 0,
    });
  });
});

describe("endpointNotes", () => {
  it("warns when a tool turn has nowhere to route", () => {
    // The state that makes `require_parameters: true` fail a turn rather than
    // degrade it — worth knowing before the turn, not after it errors.
    const notes = endpointNotes(
      summarizeEndpoints([
        endpoint({ providerName: "a", supportedParameters: ["temperature"], promptPrice: 1 }),
      ]),
      { toolRequirement: true }
    );
    expect(notes[0]).toContain("No endpoint of this model declares tool support");
  });

  it("warns when tool support rests on a single endpoint", () => {
    const notes = endpointNotes(
      summarizeEndpoints([
        endpoint({ providerName: "a", supportedParameters: ["tools"], promptPrice: 1 }),
        endpoint({ providerName: "b", supportedParameters: ["temperature"], promptPrice: 1 }),
      ]),
      { toolRequirement: true }
    );
    expect(notes[0]).toContain("Only one of 2 endpoints");
  });

  it("says nothing about tools for a request that asserts no parameters", () => {
    const notes = endpointNotes(
      summarizeEndpoints([endpoint({ providerName: "a", supportedParameters: ["temperature"] })]),
      { toolRequirement: false }
    );
    expect(notes.join(" ")).not.toContain("tool support");
  });

  it("states that caching cannot save anything when no endpoint offers it", () => {
    const notes = endpointNotes(
      summarizeEndpoints([
        endpoint({ providerName: "a", supportedParameters: ["tools"], promptPrice: 1 }),
        endpoint({ providerName: "b", supportedParameters: ["tools"], promptPrice: 2 }),
      ]),
      { toolRequirement: true }
    );
    expect(notes.some((n) => n.includes("cannot save anything"))).toBe(true);
  });

  it("distinguishes a published cache rate from an actual implicit cache", () => {
    // A rate to bill a hit does not mean the provider creates the hit. This is
    // exactly the capture's state: rates published, implicit caching false.
    const withRate = summarizeEndpoints([
      endpoint({
        providerName: "a",
        supportedParameters: ["tools"],
        promptPrice: 1,
        cacheReadPrice: 0.1,
      }),
      endpoint({ providerName: "a", supportedParameters: ["tools"], promptPrice: 1.5 }),
    ]);
    const notes = endpointNotes(withRate, { toolRequirement: true });
    expect(notes.some((n) => n.includes("none reports implicit caching"))).toBe(true);
  });

  it("notes a single-provider model as having nothing to fail over to", () => {
    const notes = endpointNotes(
      summarizeEndpoints([
        endpoint({
          providerName: "only",
          supportedParameters: ["tools"],
          promptPrice: 1,
          supportsImplicitCaching: true,
        }),
      ]),
      { toolRequirement: true }
    );
    expect(notes).toEqual(["One provider serves this model, so there is nothing to fail over to."]);
  });

  it("states the spread when several providers differ in price", () => {
    const notes = endpointNotes(
      summarizeEndpoints([
        endpoint({
          providerName: "cheap",
          supportedParameters: ["tools"],
          promptPrice: 1,
          supportsImplicitCaching: true,
        }),
        endpoint({
          providerName: "dear",
          supportedParameters: ["tools"],
          promptPrice: 3,
          supportsImplicitCaching: true,
        }),
      ]),
      { toolRequirement: true }
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("3.0×");
  });
});
