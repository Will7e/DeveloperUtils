// ============================================================
// Model Catalog — The Live Catalog Outranks The Curated Stub
// ============================================================
// The bug these pin: `resolveModelInfo` returned the curated stub the instant
// an id matched one of the six hand-written entries, and every stub is a name
// plus a context length with no `supportedParameters` and no `reasoning`
// block. So for exactly those models the app could never see the capabilities
// the fetched catalog described — the reasoning ("tier") control stayed
// hidden, and no reasoning key was ever sent on the wire.
//
// The rule now: whatever the live catalog declares wins; the stub fills only
// what the live entry leaves out.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./openrouter-client", () => ({
  listModels: vi.fn(async () => CATALOG),
}));

import { ensureModelCatalog, resolveModelInfo } from "./model-catalog";
import type { ModelInfo } from "../types";

/** What a real catalog entry for a curated model looks like. */
const CATALOG: ModelInfo[] = [
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini (live)",
    contextLength: 128_000,
    promptPrice: 0.15,
    completionPrice: 0.6,
    supportedParameters: ["temperature", "reasoning"],
    reasoning: { supportedEfforts: ["low", "medium", "high"] },
  },
  {
    id: "brand/new-model",
    name: "Brand New",
    contextLength: 64_000,
    supportedParameters: ["temperature"],
  },
];

beforeEach(async () => {
  // Populates the module-level cache the resolver reads synchronously.
  await ensureModelCatalog("sk-test");
});

describe("resolveModelInfo", () => {
  it("lets the live catalog describe a curated model", async () => {
    const info = resolveModelInfo("openai/gpt-4o-mini");

    expect(info?.reasoning?.supportedEfforts).toEqual(["low", "medium", "high"]);
    expect(info?.supportedParameters).toContain("reasoning");
    expect(info?.name).toBe("GPT-4o mini (live)");
    expect(info?.completionPrice).toBe(0.6);
  });

  it("resolves a model the curated list has never heard of", () => {
    expect(resolveModelInfo("brand/new-model")?.contextLength).toBe(64_000);
    // Not curated: nothing to fill in, and nothing invented.
    expect(resolveModelInfo("brand/new-model")?.supportedParameters).toEqual([
      "temperature",
    ]);
  });

  it("still answers with the curated stub for an unlisted id", () => {
    // A catalog fetch that omits a curated model (or a cold start) must not
    // lose the context window — a model without one cannot be budgeted.
    const info = resolveModelInfo("anthropic/claude-3.5-sonnet");

    expect(info?.contextLength).toBe(200_000);
    expect(info?.name).toBe("Claude 3.5 Sonnet");
    // The stub declares no capabilities, and this must stay honest rather
    // than guessed: no reasoning controls where none are known.
    expect(info?.reasoning).toBeUndefined();
    expect(info?.supportedParameters).toBeUndefined();
  });

  it("says nothing for an unknown or empty id", () => {
    expect(resolveModelInfo("nobody/knows-this-one")).toBeUndefined();
    expect(resolveModelInfo(undefined)).toBeUndefined();
    expect(resolveModelInfo("")).toBeUndefined();
  });
});
