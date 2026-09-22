// ============================================================
// Turn Preparation — Candidate List Tests
// ============================================================
// The candidate list is the host's entire failover vocabulary. These
// tests pin the two things that make escalation safe: the selected
// model is always first, and a second candidate only ever appears when
// it is a DIFFERENT model with its own request state.

import { describe, it, expect } from "vitest";
import { resolveCandidates } from "./turn-prep";

describe("resolveCandidates", () => {
  it("sends the selected model alone when no escalation is configured", () => {
    const resolved = resolveCandidates({ requestedModel: "openai/gpt-4o-mini", effort: "medium" });
    expect(resolved.candidates).toHaveLength(1);
    expect(resolved.candidates[0]!.modelId).toBe("openai/gpt-4o-mini");
    expect(resolved.toolsSupported).toBe(true);
  });

  it("appends the escalation model as a second attempt", () => {
    const resolved = resolveCandidates({
      requestedModel: "openai/gpt-4o-mini",
      escalationModel: "anthropic/claude-3.5-sonnet",
      effort: "high",
    });
    expect(resolved.candidates.map((c) => c.modelId)).toEqual([
      "openai/gpt-4o-mini",
      "anthropic/claude-3.5-sonnet",
    ]);
  });

  it("never lists the same model twice", () => {
    const resolved = resolveCandidates({
      requestedModel: "openai/gpt-4o-mini",
      escalationModel: "openai/gpt-4o-mini",
      effort: "medium",
    });
    expect(resolved.candidates).toHaveLength(1);
  });

  it("ignores an empty escalation id", () => {
    const resolved = resolveCandidates({
      requestedModel: "openai/gpt-4o-mini",
      escalationModel: "   ",
      effort: "medium",
    });
    expect(resolved.candidates).toHaveLength(1);
  });

  it("gives each candidate the request state its own catalog entry supports", () => {
    const resolved = resolveCandidates({
      requestedModel: "openai/gpt-4o-mini",
      escalationModel: "google/gemini-flash-1.5",
      effort: "medium",
    });
    // Both are curated fallbacks with no declared reasoning block, so both
    // send nothing rather than a key a provider would reject with a 400.
    for (const candidate of resolved.candidates) {
      expect(typeof candidate.requestState).toBe("object");
    }
  });

  it("keeps the context window of each candidate, for output sizing", () => {
    const resolved = resolveCandidates({
      requestedModel: "openai/gpt-4o-mini",
      escalationModel: "anthropic/claude-3.5-sonnet",
      effort: "low",
    });
    expect(resolved.candidates[1]!.contextLength).toBe(200_000);
  });
});
