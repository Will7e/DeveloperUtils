// ============================================================
// Model State — Capability Snapping & Tool Gating Tests
// ============================================================
// Replaces the retired InTab tier/tool-capability suites. With a
// repo attached every turn carries tool definitions, and strict
// providers reject tools sent to a model that cannot call them — so
// the gate must refuse only models the catalog says are incapable.
// Absence of metadata is NOT evidence of incapability (the curated
// fallback list declares none).
//
// The effort tests pin the OpenRouter contract that replaced the
// InTab tiers: a chosen rung is snapped to the model's declared
// `supported_efforts`, the modern `reasoning.effort` map is preferred
// (it is the only key that accepts "max"), and nothing is sent when
// the catalog has no capability data — an unsupported key is a 400.

import { describe, it, expect } from "vitest";
import {
  availableEfforts,
  defaultEffortFor,
  modelSupportsReasoning,
  modelSupportsTools,
  resolveEffortState,
} from "./model-state";
import { AGENT_TOOLS, PLAN_MODE_TOOLS, toolsForMode } from "./tool-registry";
import type { ModelInfo } from "../types";

function model(
  params?: string[],
  reasoning?: ModelInfo["reasoning"]
): ModelInfo {
  return {
    id: "any/model",
    name: "Any Model",
    contextLength: 128_000,
    ...(params ? { supportedParameters: params } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

describe("modelSupportsTools", () => {
  it("accepts a model that declares tools", () => {
    expect(modelSupportsTools(model(["tools", "temperature"]))).toBe(true);
  });

  it("rejects a model whose declared parameters lack tools", () => {
    expect(modelSupportsTools(model(["temperature", "logit_bias"]))).toBe(false);
  });

  it("allows unknown metadata through", () => {
    expect(modelSupportsTools(model())).toBe(true);
    expect(modelSupportsTools(model([]))).toBe(true);
    expect(modelSupportsTools(undefined)).toBe(true);
  });
});

describe("modelSupportsReasoning", () => {
  it("is true when the model advertises either reasoning key", () => {
    expect(modelSupportsReasoning(model(["reasoning_effort"]))).toBe(true);
    expect(modelSupportsReasoning(model(["reasoning"]))).toBe(true);
  });

  it("is false without reasoning metadata", () => {
    expect(modelSupportsReasoning(model(["tools"]))).toBe(false);
    expect(modelSupportsReasoning(model())).toBe(false);
    expect(modelSupportsReasoning(undefined)).toBe(false);
  });
});

describe("resolveEffortState", () => {
  it("passes the exact rung through when the model supports it", () => {
    const info = model(["reasoning_effort"], {
      supportedEfforts: ["high", "medium", "low"],
    });
    expect(resolveEffortState("high", info)).toEqual({ reasoning_effort: "high" });
  });

  it("snaps to the closest supported effort (ternary-bonsai: [xhigh, medium])", () => {
    const xhighOnly = model(["reasoning_effort"], {
      supportedEfforts: ["xhigh", "medium"],
    });
    // Our "low" sits between nothing and "medium" → nearest is medium
    expect(resolveEffortState("low", xhighOnly)).toEqual({ reasoning_effort: "medium" });
    // Our "max" snaps down to the deep end the model accepts
    expect(resolveEffortState("max", xhighOnly)).toEqual({ reasoning_effort: "xhigh" });
  });

  it("snaps to the model's own vocabulary (GLM FlashX: [max, high, low])", () => {
    const flashx = model(["reasoning_effort"], {
      supportedEfforts: ["max", "high", "low"],
    });
    // "medium" sits between low and high; the deeper one wins the tie
    expect(resolveEffortState("medium", flashx)).toEqual({ reasoning_effort: "high" });
  });

  it("omits reasoning keys entirely for models without support", () => {
    expect(resolveEffortState("high", model(["temperature", "tools"]))).toEqual({});
    expect(resolveEffortState("high", undefined)).toEqual({});
    expect(resolveEffortState("high", model())).toEqual({});
  });

  it("stays conservative when the catalog has not loaded", () => {
    // Sending an unsupported key would 400 the whole request
    expect(resolveEffortState("low", undefined)).toEqual({});
    expect(resolveEffortState(undefined, model(["reasoning_effort"]))).toEqual({});
  });

  it("prefers the reasoning map (the only key that accepts max)", () => {
    const both = model(["reasoning", "reasoning_effort"], {
      supportedEfforts: ["max", "high", "low"],
    });
    expect(resolveEffortState("max", both)).toEqual({ reasoning: { effort: "max" } });
    expect(resolveEffortState("low", both)).toEqual({ reasoning: { effort: "low" } });
  });

  it("clamps max to xhigh on the reasoning_effort alias", () => {
    // The alias enum is (xhigh, high, medium, low, minimal, none) — no "max"
    const aliasOnly = model(["reasoning_effort"], { supportedEfforts: ["max", "xhigh", "low"] });
    expect(resolveEffortState("max", aliasOnly)).toEqual({ reasoning_effort: "xhigh" });
  });

  it("sends the raw desire when effort is advertised without a supported list", () => {
    expect(resolveEffortState("medium", model(["reasoning_effort"]))).toEqual({
      reasoning_effort: "medium",
    });
  });

  it("expresses an explicit off state only via the map, never when mandatory", () => {
    const offable = model(["reasoning"], { supportedEfforts: ["none", "low", "high"] });
    expect(resolveEffortState("low", offable)).toEqual({ reasoning: { effort: "low" } });

    const mandatory = model(["reasoning"], {
      supportedEfforts: ["low", "high"],
      mandatory: true,
    });
    expect(resolveEffortState("low", mandatory)).toEqual({ reasoning: { effort: "low" } });
  });
});

describe("availableEfforts", () => {
  it("offers all four rungs for a model with no effort restriction", () => {
    expect(availableEfforts(model(["reasoning_effort"]))).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("narrows to the rungs the model can express", () => {
    const info = model(["reasoning_effort"], { supportedEfforts: ["high", "medium"] });
    expect(availableEfforts(info)).toEqual(["low", "medium", "high", "max"]);
  });

  it("is empty for a model that cannot reason (hides the control)", () => {
    expect(availableEfforts(model(["tools"]))).toEqual([]);
    expect(availableEfforts(undefined)).toEqual([]);
  });
});

describe("defaultEffortFor", () => {
  it("uses the model's own default when it maps to a rung", () => {
    expect(defaultEffortFor(model(["reasoning_effort"], { defaultEffort: "high" }))).toBe("high");
  });

  it("maps provider vocabulary (xhigh/minimal) onto our rungs", () => {
    expect(defaultEffortFor(model(["reasoning"], { defaultEffort: "xhigh" }))).toBe("max");
    expect(defaultEffortFor(model(["reasoning"], { defaultEffort: "minimal" }))).toBe("low");
  });

  it("falls back to medium", () => {
    expect(defaultEffortFor(model(["reasoning_effort"]))).toBe("medium");
    expect(defaultEffortFor(undefined)).toBe("medium");
  });
});

describe("agent modes", () => {
  it("build mode sends every agent tool", () => {
    expect(toolsForMode("build")).toHaveLength(AGENT_TOOLS.length);
  });

  it("plan mode withholds every mutating tool", () => {
    const planNames = PLAN_MODE_TOOLS.map((t) => t.function.name);
    for (const mutating of [
      "write_file",
      "edit_file",
      "delete_file",
      "create_working_branch",
      "push_changes",
    ]) {
      expect(planNames).not.toContain(mutating);
    }
    // Read-only investigation stays available — plan mode must be able
    // to ground a plan in the actual code.
    expect(planNames).toContain("read_file");
    expect(planNames).toContain("search_workspace");
    expect(planNames).toContain("get_workspace_diff");
    expect(planNames).toContain("run_tool_program");
  });

  it("plan mode is a strict subset of the full tool set", () => {
    const all = new Set(AGENT_TOOLS.map((t) => t.function.name));
    for (const t of PLAN_MODE_TOOLS) expect(all.has(t.function.name)).toBe(true);
    expect(PLAN_MODE_TOOLS.length).toBeLessThan(AGENT_TOOLS.length);
  });
});
