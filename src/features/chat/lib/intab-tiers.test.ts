// ============================================================
// InTab Flash Tiers — Routing Regression Tests
// ============================================================
// The virtual model ships in three tiers (Light / High / Max)
// sharing one router. These tests pin the tier contract:
//  - all three synthetic ids are recognized InTab models
//  - each tier routes through its own pool order
//  - the task kind reorders WITHIN a tier, never across tiers
//  - the vision gate still filters text-only models
//  - the faster 2s hedge trigger is in force
//  - the cold-start fallback pool is a valid non-empty pool
//    (pre-refresh regression: entries lacked isFree → empty pool)

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  INTAB_FALLBACK_POOL,
  INTAB_HEDGE_TRIGGER_MS,
  INTAB_MODEL_ID,
  INTAB_TIER_DESIRED_STATE,
  INTAB_TIER_VIRTUAL_MODELS,
} from "../constants";
import {
  buildInTabPool,
  displayNameFor,
  isIntabModel,
  pickInTabModel,
  resetDailyUsage,
  resetInTabFailures,
  snapRequestStateForModel,
  type PickInTabModelResult,
} from "./intab-llm";
import { resetLearnState } from "./intab-learn";
import { ensureModelCatalog } from "./model-catalog";
import type { ModelInfo } from "../types";

// The router reads the shared model-catalog cache. Populate it via a
// mocked listModels so pool tests run against a realistic catalog.
const { mockCatalog } = vi.hoisted(() => ({
  mockCatalog: [] as ModelInfo[],
}));
vi.mock("../lib/openrouter-client", () => ({
  listModels: vi.fn(async () => mockCatalog),
}));

function model(id: string, contextLength = 262144, inputModalities?: string[]): ModelInfo {
  return {
    id,
    name: id,
    contextLength,
    isFree: true,
    ...(inputModalities ? { inputModalities } : {}),
  } as ModelInfo;
}

/** Live-catalog-shaped fixture covering the full tier pool space */
const CATALOG: ModelInfo[] = [
  model("dots-studio/dots-3-note-preview:free", 262144, ["text", "image"]),
  model("nex-agi/nex-n2.5-pro:free"),
  model("nex-agi/nex-n2.5-mini:free"),
  model("inclusionai/ling-3.0-flash:free"),
  model("qwen/qwen3-coder:free"),
  model("openai/gpt-oss-120b:free", 131072, ["text", "image"]),
  model("openai/gpt-oss-20b:free", 131072, ["text", "image"]),
  model("google/gemma-4-31b:free"),
  model("google/gemma-4-26b:free"),
  model("nvidia/nemotron-3-ultra-550b-a55b:free", 1_000_000),
  // Paid models must never enter any tier pool (isFree: false —
  // buildInTabPool's gate must exclude it)
  {
    ...model("anthropic/claude-opus-4.7", 200000),
    isFree: false,
  } as ModelInfo,
];

function ids(models: ModelInfo[]): string[] {
  return models.map((m) => m.id);
}

function setCatalog(models: ModelInfo[]): void {
  mockCatalog.splice(0, mockCatalog.length, ...models);
}

beforeEach(async () => {
  resetInTabFailures();
  resetDailyUsage();
  resetLearnState();
  setCatalog(CATALOG);
  await ensureModelCatalog("test-key");
});

describe("tier ids", () => {
  it("recognizes all three synthetic tier ids as InTab models", () => {
    expect(isIntabModel("intab/intab-llm")).toBe(true);
    expect(isIntabModel("intab/intab-llm-light")).toBe(true);
    expect(isIntabModel("intab/intab-llm-max")).toBe(true);
  });

  it("rejects real catalog ids", () => {
    expect(isIntabModel("openai/gpt-oss-120b:free")).toBe(false);
    expect(isIntabModel(undefined)).toBe(false);
    expect(isIntabModel("")).toBe(false);
  });

  it("resolves virtual metadata for every tier id", () => {
    const tierIds = INTAB_TIER_VIRTUAL_MODELS.map((m) => m.id);
    expect(tierIds).toContain("intab/intab-llm-light");
    expect(tierIds).toContain(INTAB_MODEL_ID);
    expect(tierIds).toContain("intab/intab-llm-max");
  });
});

describe("per-tier pools", () => {
  it("Light leads with the fastest model (dots-3-note)", () => {
    const pool = buildInTabPool(CATALOG, "light");
    expect(pool[0]!.id).toBe("dots-studio/dots-3-note-preview:free");
    // Speed-oriented order: the 550B heavyweight must not be near the top
    const nemotronIdx = ids(pool).findIndex((id) => id.startsWith("nvidia/"));
    expect(nemotronIdx).toBeGreaterThan(4);
  });

  it("High (default) leads with ling-3.0-flash", () => {
    const pool = buildInTabPool(CATALOG, "high");
    expect(pool[0]!.id).toBe("inclusionai/ling-3.0-flash:free");
  });

  it("Max leads with nex-n2.5-pro and keeps the big generalists early", () => {
    const pool = buildInTabPool(CATALOG, "max");
    expect(pool[0]!.id).toBe("nex-agi/nex-n2.5-pro:free");
    const head = ids(pool).slice(0, 4);
    expect(head.some((id) => id.startsWith("openai/gpt-oss-120b"))).toBe(true);
  });

  it("tiers differ in their leading models", () => {
    const light = buildInTabPool(CATALOG, "light")[0]!.id;
    const high = buildInTabPool(CATALOG, "high")[0]!.id;
    const max = buildInTabPool(CATALOG, "max")[0]!.id;
    expect(new Set([light, high, max]).size).toBe(3);
  });

  it("never includes paid models", () => {
    for (const tier of ["light", "high", "max"] as const) {
      const pool = buildInTabPool(CATALOG, tier);
      expect(ids(pool)).not.toContain("anthropic/claude-opus-4.7");
    }
  });
});

describe("pickInTabModel", () => {
  const CONV = "conv-tiers";

  function pick(
    tierModelId: string,
    turnKind?: "quick" | "code" | "analysis" | "vision" | "agent"
  ): PickInTabModelResult | null {
    return pickInTabModel({
      conversationId: CONV,
      turnKind,
      tierModelId,
    });
  }

  it("routes the Light tier to dots-3-note by default", () => {
    expect(pick("intab/intab-llm-light")!.modelId).toBe(
      "dots-studio/dots-3-note-preview:free"
    );
  });

  it("routes the default (High) tier to ling-3.0-flash", () => {
    expect(pick(INTAB_MODEL_ID)!.modelId).toBe("inclusionai/ling-3.0-flash:free");
  });

  it("routes the Max tier to nex-n2.5-pro", () => {
    expect(pick("intab/intab-llm-max")!.modelId).toBe("nex-agi/nex-n2.5-pro:free");
  });

  it("lifts qwen3-coder within High for code turns (kind refines tier)", () => {
    const highBase = buildInTabPool(CATALOG, "high");
    expect(highBase[0]!.id).toBe("inclusionai/ling-3.0-flash:free");
    expect(pick(INTAB_MODEL_ID, "code")!.modelId).toBe("qwen/qwen3-coder:free");
  });

  it("never crosses tiers: a code turn in Light stays Light-led", () => {
    // Light's pool puts dots-3-note first; even the code lift (qwen3-coder
    // sits 6 ranks down in Light) must not push dots-3-note out of the lead.
    expect(pick("intab/intab-llm-light", "code")!.modelId).toBe(
      "dots-studio/dots-3-note-preview:free"
    );
  });

  it("vision turns filter text-only models out of the Light tier", async () => {
    // Make the Light leader text-only for this test, refresh the cache
    const textOnly = CATALOG.map((m) =>
      m.id === "dots-studio/dots-3-note-preview:free"
        ? model(m.id, m.contextLength, ["text"])
        : m
    );
    setCatalog(textOnly);
    await ensureModelCatalog("test-key");

    const result = pickInTabModel({
      conversationId: "conv-vision",
      turnKind: "vision",
      needsVision: true,
      tierModelId: "intab/intab-llm-light",
    });
    expect(result).not.toBeNull();
    // The text-only leader must be filtered out; a vision-capable
    // model wins instead (nex-n2.5-mini is the top surviving candidate).
    expect(result!.modelId).not.toBe("dots-studio/dots-3-note-preview:free");
    expect(result!.modelId).toBe("nex-agi/nex-n2.5-mini:free");
  });
});

describe("per-tier OpenRouter request state", () => {
  it("Light desires low reasoning effort with thinking excluded", () => {
    expect(INTAB_TIER_DESIRED_STATE["intab/intab-llm-light"]).toEqual({
      reasoningEffort: "low",
      excludeThinking: true,
    });
  });

  it("High desires medium reasoning effort", () => {
    expect(INTAB_TIER_DESIRED_STATE[INTAB_MODEL_ID]).toEqual({
      reasoningEffort: "medium",
      excludeThinking: false,
    });
  });

  it("Max desires high reasoning effort with the reasoning panel visible", () => {
    expect(INTAB_TIER_DESIRED_STATE["intab/intab-llm-max"]).toEqual({
      reasoningEffort: "high",
      excludeThinking: false,
    });
  });
});

describe("latency knobs", () => {
  it("hedge fires after 2 seconds", () => {
    expect(INTAB_HEDGE_TRIGGER_MS).toBe(2000);
  });
});

describe("cold-start fallback pool", () => {
  it("is a valid non-empty pool for every tier (isFree regression)", () => {
    // Pre-refresh regression: fallback entries lacked isFree, so
    // buildInTabPool filtered them all out → empty pool → dead turns
    // until the catalog loaded.
    for (const tier of ["light", "high", "max"] as const) {
      const pool = buildInTabPool(INTAB_FALLBACK_POOL, tier);
      expect(pool.length).toBeGreaterThan(0);
    }
  });

  it("falls back to new-generation families, not the 550B heavyweight", () => {
    const first = INTAB_FALLBACK_POOL[0]!.id;
    expect(first).not.toMatch(/^nvidia\//);
    expect(first).toBe("dots-studio/dots-3-note-preview:free");
  });
});

describe("display mask", () => {
  it("renders the product model name for every tier id", () => {
    // The tier is a background state, not a separate model — the UI
    // always reads "InTab Flash 5.5" regardless of tier.
    expect(displayNameFor("intab/intab-llm-light", [])).toBe("InTab Flash 5.5");
    expect(displayNameFor(INTAB_MODEL_ID, [])).toBe("InTab Flash 5.5");
    expect(displayNameFor("intab/intab-llm-max", [])).toBe("InTab Flash 5.5");
  });

  it("falls back to catalog names for real models", () => {
    expect(
      displayNameFor("openai/gpt-oss-120b:free", [
        model("openai/gpt-oss-120b:free"),
      ])
    ).toBe("openai/gpt-oss-120b:free");
  });
});

describe("capability-snapped request state (live OpenRouter catalog)", () => {
  /** Fake a catalog model declaring specific reasoning capabilities */
  function withCapabilities(
    supportedParameters: string[],
    reasoning?: ModelInfo["reasoning"]
  ): ModelInfo {
    return { ...model("any/model"), supportedParameters, reasoning } as ModelInfo;
  }

  it("passes the desired effort through when the model supports it", () => {
    const info = withCapabilities(
      ["reasoning_effort"],
      { supportedEfforts: ["low", "medium", "high"] }
    );
    expect(snapRequestStateForModel("intab/intab-llm-max", info)).toEqual({
      reasoning_effort: "high",
    });
  });

  it("snaps to the closest supported effort (ternary-bonsai: [xhigh, medium])", () => {
    // Live-catalog finding: some models only accept ["xhigh","medium"]
    const xhighOnly = withCapabilities(
      ["reasoning_effort"],
      { supportedEfforts: ["xhigh", "medium"] }
    );
    // Light wants "low" → snaps to "medium" (nearest, ties → deeper)
    expect(snapRequestStateForModel("intab/intab-llm-light", xhighOnly)).toEqual({
      reasoning_effort: "medium",
    });
    // Max wants "high" → snaps to "xhigh" (nearest)
    expect(snapRequestStateForModel("intab/intab-llm-max", xhighOnly)).toEqual({
      reasoning_effort: "xhigh",
    });
  });

  it("snaps to the model's own effort vocabulary (GLM FlashX: [max, high, low])", () => {
    // Live-catalog finding: GLM 5.3 FlashX accepts ["max","high","low"]
    const flashx = withCapabilities(
      ["reasoning_effort"],
      { supportedEfforts: ["max", "high", "low"] }
    );
    // High wants "medium" → snaps to "low" or "high"? "medium" sits
    // between; the deeper one wins the tie per tier intent → "high"
    expect(snapRequestStateForModel(INTAB_MODEL_ID, flashx)).toEqual({
      reasoning_effort: "high",
    });
  });

  it("omits all reasoning keys for models with no reasoning capability", () => {
    // Live-catalog finding: unbiased/pareto supports neither param
    const bare = withCapabilities(["temperature", "tools"]);
    expect(snapRequestStateForModel("intab/intab-llm-light", bare)).toEqual({});
    expect(snapRequestStateForModel("intab/intab-llm-max", bare)).toEqual({});
  });

  it("stays conservative when the catalog has not loaded (no capability data)", () => {
    // Offline / cold-start: sending an unsupported key would 400 the
    // whole request — omit everything and take provider defaults.
    expect(snapRequestStateForModel("intab/intab-llm-light", undefined)).toEqual({});
    expect(snapRequestStateForModel("intab/intab-llm-light", model("any/model"))).toEqual({});
  });

  it("emits reasoning.exclude only for models that accept the reasoning map", () => {
    const effortOnly = withCapabilities(["reasoning_effort"]);
    const state = snapRequestStateForModel("intab/intab-llm-light", effortOnly);
    expect(state).toEqual({ reasoning_effort: "low" });

    const both = withCapabilities(
      ["reasoning", "reasoning_effort"],
      { supportedEfforts: ["low"] }
    );
    expect(snapRequestStateForModel("intab/intab-llm-light", both)).toEqual({
      reasoning_effort: "low",
      reasoning: { exclude: true },
    });
  });

  it("returns empty state for real (non-tier) models — pass-through untouched", () => {
    const info = withCapabilities(
      ["reasoning_effort"],
      { supportedEfforts: ["high"] }
    );
    expect(snapRequestStateForModel("openai/gpt-oss-120b:free", info)).toEqual({});
    expect(snapRequestStateForModel(undefined, info)).toEqual({});
  });

  it("sends the raw desire when effort is advertised without a supported list", () => {
    const advertised = withCapabilities(["reasoning_effort"]);
    expect(snapRequestStateForModel(INTAB_MODEL_ID, advertised)).toEqual({
      reasoning_effort: "medium",
    });
  });
});
