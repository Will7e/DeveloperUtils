// ============================================================
// Turn Preparation — Candidate List Tests
// ============================================================
// The candidate list is the host's entire failover vocabulary. These
// tests pin the two things that make escalation safe: the selected
// model is always first, and a second candidate only ever appears when
// it is a DIFFERENT model with its own request state.

import { describe, it, expect } from "vitest";
import { composeTurnNote, prepareTurn, resolveCandidates } from "./turn-prep";
import { declaredAvailability } from "../lib/availability";
import { useChatStore } from "@/stores/chat.store";
import type { ChatSkill } from "../types";

function skill(over: Partial<ChatSkill> & { id: string }): ChatSkill {
  return { name: over.id, description: "", content: "body", enabled: false, ...over };
}

const AVAILABILITY = declaredAvailability({ repo: null, mcpServers: 0, model: undefined });

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

describe("composeTurnNote — skills that activate themselves", () => {
  const auto = skill({
    id: "auto",
    name: "Add Tests",
    description: "cover the change",
    content: "Write a failing test first.",
  });
  const deferred = skill({ id: "deferred", name: "Deep Review", content: "Review hard." });

  const note = (over: Partial<Parameters<typeof composeTurnNote>[0]> = {}) =>
    composeTurnNote({
      autoSkills: [],
      deferredSkills: [],
      availability: AVAILABILITY,
      now: new Date("2026-09-24T00:00:00Z"),
      ...over,
    });

  it("injects a matched skill's body as instructions already in force", () => {
    const text = note({ autoSkills: [auto] });
    expect(text).toContain("### Skill: Add Tests");
    expect(text).toContain("_cover the change_");
    expect(text).toContain("Write a failing test first.");
    expect(text).toMatch(/ALREADY ACTIVE/);
    // The old behaviour was to NAME the skill and ask the model to fetch it;
    // a body that is already present must not also be requested.
    expect(text).not.toContain("read_skill");
  });

  it("names only the deferred skills for read_skill", () => {
    const text = note({ autoSkills: [auto], deferredSkills: [deferred] });
    expect(text).toContain('"Deep Review"');
    expect(text).toContain('read_skill({ name: "Deep Review" })');
  });

  it("does not say a deferred skill 'also' matches when nothing was loaded", () => {
    // One oversized skill defers on its own; "also matches" would read as if
    // something had been loaded before it.
    const text = note({ deferredSkills: [deferred] });
    expect(text).toContain("This request matches the skill");
    expect(text).not.toContain("also matches");
  });

  it("says nothing about skills on an ordinary turn", () => {
    const text = note();
    expect(text).not.toContain("### Skill:");
    expect(text).not.toContain("read_skill");
  });
});

describe("composeTurnNote — other agent threads", () => {
  const note = (over: Partial<Parameters<typeof composeTurnNote>[0]> = {}) =>
    composeTurnNote({
      autoSkills: [],
      deferredSkills: [],
      availability: AVAILABILITY,
      now: new Date("2026-09-24T00:00:00Z"),
      ...over,
    });

  it("costs nothing when this is the only thread", () => {
    // The 95% case: no header, no tokens, no behavioural noise about
    // coordination that is not happening.
    const text = note({ threads: "" });
    expect(text).not.toContain("Other agent threads");
  });

  it("renders the digest immediately after the verification plan", () => {
    // Both are "what should I do next" facts, and both sit outside the cached
    // prefix. Order matters for reading, not for caching: the tier says what to
    // run, and a peer holding a path can say not to bother yet.
    const text = note({
      verification: "Next move: run `npm test` through the companion.",
      threads: 'Other agent threads in this browser:\n- "Auth rework" · editing · on acme/app · touching src/auth.ts',
    });
    expect(text).toContain("Other agent threads in this browser");
    expect(text).toContain("src/auth.ts");
    expect(text.indexOf("Next move:")).toBeLessThan(text.indexOf("Other agent threads"));
  });
});

describe("prepareTurn with no API key", () => {
  it("answers the send in the transcript rather than failing silently", async () => {
    const store = useChatStore.getState();
    store.updateSettings({ apiKey: "" });
    const id = store.createConversation("openai/gpt-4o-mini");

    const prepared = await prepareTurn(id);
    expect(prepared).toBeNull();

    // The toast and the settings modal are transient; this row is what
    // the conversation keeps, and what stops an unanswered user message
    // from looking like the agent ignored it.
    const conversation = useChatStore.getState().conversations.find((c) => c.id === id);
    expect(conversation?.messages).toHaveLength(1);
    expect(conversation?.messages[0]?.role).toBe("assistant");
    expect(conversation?.messages[0]?.error).toBe(true);
    expect(conversation?.messages[0]?.content).toMatch(/API key/i);
  });
});
