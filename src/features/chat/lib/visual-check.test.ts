// ============================================================
// Visual Check — Tests
// ============================================================
// The interesting cases are the failures: a capture that arrives
// malformed, a model that ignores the answer contract, a catalog
// with nothing that can see. Each one has to produce an honest
// "we did not establish that" rather than an accidental approval.

import { describe, it, expect } from "vitest";
import {
  SCREENSHOT_MAX_CHARS,
  buildVisualCheckPrompt,
  captureCaveat,
  normalizeScreenshot,
  parseVisualVerdict,
  pickVisionModel,
  visualCheckPassed,
  visualCheckStatement,
} from "./visual-check";
import type { ModelInfo } from "../types";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function capture(overrides: Record<string, unknown> = {}) {
  return { dataUrl: PNG, width: 800, height: 600, selector: null, approximate: true, ...overrides };
}

function model(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: overrides.id,
    contextLength: 128_000,
    ...overrides,
  } as ModelInfo;
}

describe("normalizeScreenshot", () => {
  it("accepts a well-formed capture", () => {
    expect(normalizeScreenshot(capture())).toEqual({
      dataUrl: PNG,
      width: 800,
      height: 600,
      selector: null,
      approximate: true,
    });
  });

  it("rejects a payload that is not an object", () => {
    expect(normalizeScreenshot(null)).toBeNull();
    expect(normalizeScreenshot("data:image/png;base64,AAA")).toBeNull();
  });

  it("rejects a data URL that is not an image", () => {
    expect(normalizeScreenshot(capture({ dataUrl: "https://evil.example.com/x.png" }))).toBeNull();
    expect(normalizeScreenshot(capture({ dataUrl: "data:text/html;base64,AAA" }))).toBeNull();
  });

  it("rejects an oversized capture", () => {
    const huge = "data:image/png;base64," + "A".repeat(SCREENSHOT_MAX_CHARS);
    expect(normalizeScreenshot(capture({ dataUrl: huge }))).toBeNull();
  });

  it("rejects a capture with no usable dimensions", () => {
    expect(normalizeScreenshot(capture({ width: 0 }))).toBeNull();
    expect(normalizeScreenshot(capture({ height: Number.NaN }))).toBeNull();
  });

  it("keeps only a string selector and treats a missing approximate flag as approximate", () => {
    const out = normalizeScreenshot({ dataUrl: PNG, width: 10, height: 10, selector: 7 as unknown });
    expect(out?.selector).toBeNull();
    expect(out?.approximate).toBe(true);
  });
});

describe("captureCaveat", () => {
  it("names the size, the scope, and the approximation", () => {
    const text = captureCaveat(normalizeScreenshot(capture())!);
    expect(text).toContain("800×600px");
    expect(text).toContain("viewport capture");
    expect(text).toContain("approximate");
  });

  it("names the selector when the capture was scoped", () => {
    const text = captureCaveat(normalizeScreenshot(capture({ selector: "#card" }))!);
    expect(text).toContain("`#card`");
  });
});

describe("parseVisualVerdict", () => {
  it("reads an ok verdict with no issues", () => {
    const v = parseVisualVerdict("VERDICT: ok\nISSUES:");
    expect(v.verdict).toBe("ok");
    expect(v.issues).toEqual([]);
    expect(v.malformed).toBe(false);
    expect(visualCheckPassed(v)).toBe(true);
  });

  it("reads a problem verdict with its issues", () => {
    const v = parseVisualVerdict(
      [
        "VERDICT: problem",
        "ISSUES:",
        "- The total in the summary card is white on white — unreadable.",
        "- The chart legend overlaps the axis labels.",
      ].join("\n")
    );
    expect(v.verdict).toBe("problem");
    expect(v.issues).toHaveLength(2);
    expect(v.issues[0]).toContain("white on white");
    expect(visualCheckPassed(v)).toBe(false);
  });

  it("accepts numbered issues and strips the markers", () => {
    const v = parseVisualVerdict("VERDICT: problem\nISSUES:\n1. Card is cut off\n2) Button is 2px tall");
    expect(v.issues).toEqual(["Card is cut off", "Button is 2px tall"]);
  });

  it("treats a missing verdict line as unclear, never as approval", () => {
    const v = parseVisualVerdict("The page looks fine to me, everything renders well.");
    expect(v.verdict).toBe("unclear");
    expect(v.malformed).toBe(true);
    expect(visualCheckPassed(v)).toBe(false);
    expect(v.raw).toContain("looks fine");
  });

  it("keeps a problem verdict readable when the model forgot the issue line", () => {
    const v = parseVisualVerdict("VERDICT: problem\nThe header text is invisible against the background.");
    expect(v.verdict).toBe("problem");
    expect(v.issues[0]).toContain("invisible");
  });

  it("caps the issue count and each line's length", () => {
    const body = Array.from({ length: 20 }, (_, i) => `- issue ${i} ${"x".repeat(400)}`).join("\n");
    const v = parseVisualVerdict(`VERDICT: problem\nISSUES:\n${body}`);
    expect(v.issues).toHaveLength(6);
    expect(v.issues[0]!.length).toBeLessThanOrEqual(301);
  });

  it("survives an empty answer", () => {
    const v = parseVisualVerdict("");
    expect(v.verdict).toBe("unclear");
    expect(v.issues).toEqual([]);
  });

  it("is case-insensitive about the contract", () => {
    expect(parseVisualVerdict("verdict: PROBLEM\nissues:\n- nothing visible").verdict).toBe("problem");
  });
});

describe("buildVisualCheckPrompt", () => {
  it("carries the question and the capture caveat", () => {
    const prompt = buildVisualCheckPrompt({
      question: "Is the submit button visible?",
      capture: normalizeScreenshot(capture())!,
    });
    expect(prompt).toContain("Is the submit button visible?");
    expect(prompt).toContain("800×600px");
    expect(prompt).not.toContain("claim");
  });

  it("includes the claim when one was given", () => {
    const prompt = buildVisualCheckPrompt({
      question: "Does the card show a total?",
      claim: "Added a total row to the summary card.",
      capture: normalizeScreenshot(capture())!,
    });
    expect(prompt).toContain("Added a total row");
    expect(prompt).toContain("verify or refute");
  });
});

describe("pickVisionModel", () => {
  const catalog: ModelInfo[] = [
    model({ id: "text/only", inputModalities: ["text"] }),
    model({ id: "free/vision", isFree: true, inputModalities: ["text", "image"], completionPrice: 0 }),
    model({ id: "paid/cheap", inputModalities: ["text", "image"], completionPrice: 2 }),
    model({ id: "paid/dear", inputModalities: ["image"], completionPrice: 15 }),
  ];

  it("uses the conversation's own model when it can see", () => {
    const choice = pickVisionModel("paid/cheap", catalog);
    expect(choice).toEqual({ modelId: "paid/cheap", reason: "your current model (vision-capable)" });
  });

  it("prefers a free vision-capable model over a paid one", () => {
    const choice = pickVisionModel("text/only", catalog);
    expect(choice?.modelId).toBe("free/vision");
  });

  it("falls back to the cheapest paid vision model", () => {
    const choice = pickVisionModel("text/only", catalog.filter((m) => !m.isFree));
    expect(choice?.modelId).toBe("paid/cheap");
  });

  it("returns null when nothing in the catalog can see", () => {
    expect(pickVisionModel("text/only", [model({ id: "text/only", inputModalities: ["text"] })])).toBeNull();
    expect(pickVisionModel("x", [])).toBeNull();
  });

  it("does not treat missing modality metadata as vision capability", () => {
    expect(pickVisionModel("mystery", [model({ id: "mystery" })])).toBeNull();
  });
});

describe("visualCheckStatement", () => {
  it("attributes the verdict to the model and the capture", () => {
    const shot = normalizeScreenshot(capture())!;
    const choice = { modelId: "free/vision", reason: "free vision-capable model" };
    expect(visualCheckStatement(parseVisualVerdict("VERDICT: ok\nISSUES:"), choice, shot)).toContain(
      "no visible problem"
    );
    const problem = parseVisualVerdict("VERDICT: problem\nISSUES:\n- x");
    expect(visualCheckStatement(problem, choice, shot)).toContain("1 visible problem(s)");
    expect(visualCheckStatement(problem, choice, shot)).toContain("free/vision");
  });
});
