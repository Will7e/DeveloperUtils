// ============================================================
// Provider Mark + Model Chip Label — Regression Tests
// ============================================================
// Two defects lived here, both only visible with a cold catalog
// (no key, or the first load before the list arrives):
//
//   1. the chip drew the brand mark AND the generic glyph at once,
//      so every unknown-provider row showed two icons;
//   2. the label fell back to the raw wire id, which both truncated
//      in the chip and repeated what the mark already said.
//
// The markup is rendered to a string rather than mounted: the fix is
// in what these modules emit, and no DOM is needed to see it.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderMark } from "./ProviderLogo";
import { formatModelLabel } from "../lib/model-format";

/** The generic glyph is the only mark that carries this class */
function isGenericMark(html: string): boolean {
  return html.includes("chat-provider-mark");
}

describe("ProviderMark", () => {
  it.each([
    "openai/gpt-4o",
    "deepseek/deepseek-chat",
    "anthropic/claude-3-5-sonnet",
    "x-ai/grok-3",
    "google/gemini-2.0-flash",
    "meta-llama/llama-3.3-70b",
  ])("draws the brand mark for %s", (modelId) => {
    const html = renderToStaticMarkup(ProviderMark({ modelId }));
    expect(html).toContain("<svg");
    expect(isGenericMark(html)).toBe(false);
  });

  it("draws exactly one generic glyph when the org has no mark", () => {
    const html = renderToStaticMarkup(ProviderMark({ modelId: "cohere/command-r" }));
    // One icon, not two: the chip used to stack this beside a brand mark
    // that rendered nothing, which is how "unknown provider" ended up
    // looking like a rendering bug.
    expect(html.match(/<svg/g) ?? []).toHaveLength(1);
    expect(isGenericMark(html)).toBe(true);
  });

  it("keeps the caller's sizing class on the fallback", () => {
    const html = renderToStaticMarkup(
      ProviderMark({ modelId: "cohere/command-r", className: "h-3.5 w-3.5" })
    );
    expect(html).toContain("h-3.5 w-3.5");
  });
});

describe("formatModelLabel", () => {
  it("drops the org prefix the mark already conveys", () => {
    expect(formatModelLabel("openai/gpt-oss-120b:free")).toBe("gpt-oss-120b:free");
    expect(formatModelLabel("anthropic/claude-sonnet-4")).toBe("claude-sonnet-4");
  });

  it("leaves an id without an org alone", () => {
    expect(formatModelLabel("gpt-4o")).toBe("gpt-4o");
  });

  it("falls back to the whole id rather than an empty label", () => {
    expect(formatModelLabel("openai/")).toBe("openai/");
    expect(formatModelLabel("")).toBe("");
  });
});
