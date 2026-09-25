// ============================================================
// read_skill Tool — Executor Tests
// ============================================================
// The skill body must arrive as a normal, size-capped tool result so it
// persists in the transcript; an unknown name must fail with the real
// catalogue attached, so the model can correct itself in one round.

import { describe, it, expect, beforeEach } from "vitest";
import { executeToolCall, serializeToolResult } from "./tools";
import { wrapUntrusted } from "./untrusted";
import { getSkillActivity, recordSkillActivity, resetSkillActivity } from "./skill-activity";
import { useChatStore } from "@/stores/chat.store";
import type { ChatSkill, RepoContext } from "../types";

const REPO: RepoContext = {
  owner: "acme",
  repo: "demo",
  branch: "main",
  attachedAt: 0,
};

function call(name: string, args: Record<string, unknown>, id = "c1") {
  return { id, name, arguments: JSON.stringify(args) } as Parameters<typeof executeToolCall>[0];
}

const SKILLS: ChatSkill[] = [
  {
    id: "builtin-verify-before-push",
    name: "Verify Before Push",
    description: "Definition of done before shipping",
    content: "Review the whole change set with get_workspace_diff first.",
    enabled: false,
    triggers: ["push", "ship"],
  },
  {
    id: "mine",
    name: "House Style",
    description: "Our conventions",
    content: "Two-space indent, no default exports.",
    enabled: true,
  },
];

beforeEach(() => {
  useChatStore.getState().updateSettings({ skills: SKILLS });
});

async function run(args: Record<string, unknown>) {
  return executeToolCall(call("read_skill", args), { token: "t", repo: REPO });
}

describe("read_skill", () => {
  it("returns the full body for a named skill", async () => {
    const result = await run({ name: "Verify Before Push" });
    expect(result.ok).toBe(true);
    const data = result.data as { name: string; content: string };
    expect(data.name).toBe("Verify Before Push");
    expect(data.content).toContain("get_workspace_diff");
  });

  it("finds a skill by its slug too", async () => {
    const result = await run({ name: "verify-before-push" });
    expect((result.data as { name: string }).name).toBe("Verify Before Push");
  });

  it("lists the catalogue when asked with nothing specific", async () => {
    const result = await run({});
    expect(result.ok).toBe(true);
    const data = result.data as { catalog: string; skills: unknown[] };
    expect(data.catalog).toContain("Verify Before Push");
    expect(data.catalog).toContain("(active)");
    expect(data.skills).toHaveLength(2);
  });

  it("resolves a task description to matching skills", async () => {
    const result = await run({ query: "I want to ship this change" });
    expect(result.ok).toBe(true);
    expect((result.data as { name: string }).name).toBe("Verify Before Push");
  });

  it("reports honestly when nothing matches a description", async () => {
    const result = await run({ query: "write me a haiku about databases" });
    expect(result.ok).toBe(true);
    expect((result.data as { matches: unknown[] }).matches).toEqual([]);
  });

  it("fails with the catalogue attached so the model can self-correct", async () => {
    const result = await run({ name: "Does Not Exist" });
    expect(result.ok).toBe(false);
    const data = result.data as { error: string };
    expect(data.error).toContain("Does Not Exist");
    expect(data.error).toContain("Verify Before Push");
  });

  it("marks an already-active skill as active", async () => {
    const result = await run({ name: "House Style" });
    expect((result.data as { note: string }).note).toMatch(/already active/);
  });
});

describe("read_skill → skill activity", () => {
  // The header card's "Loaded mid-turn" row is fed from the record this tool
  // writes; these pin the boundary — a BODY handed over counts, everything
  // else (listings, match lists, unknown names) does not.
  beforeEach(() => {
    resetSkillActivity();
  });

  function runInConversation(conversationId: string | undefined, args: Record<string, unknown>) {
    return executeToolCall(call("read_skill", args), {
      token: "t",
      repo: REPO,
      conversationId,
    });
  }

  it("records a named load as mid-turn activity", async () => {
    recordSkillActivity("conv-1", { auto: [], deferred: ["Verify Before Push"] });
    await runInConversation("conv-1", { name: "Verify Before Push" });
    expect(getSkillActivity("conv-1")?.loaded).toEqual(["Verify Before Push"]);
  });

  it("records a single-match query load too", async () => {
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    await runInConversation("conv-1", { query: "I want to ship this change" });
    expect(getSkillActivity("conv-1")?.loaded).toEqual(["Verify Before Push"]);
  });

  it("does not record a catalogue listing as a load", async () => {
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    await runInConversation("conv-1", {});
    expect(getSkillActivity("conv-1")?.loaded).toEqual([]);
  });

  it("does not record a multi-match result as a load", async () => {
    useChatStore.getState().updateSettings({
      skills: [
        ...SKILLS,
        { id: "two", name: "Ship Checklist", description: "another", content: "b", enabled: false, triggers: ["ship"] },
      ],
    });
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    await runInConversation("conv-1", { query: "shipping" });
    expect(getSkillActivity("conv-1")?.loaded).toEqual([]);
  });

  it("does not record an unknown skill name as a load", async () => {
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    await runInConversation("conv-1", { name: "Does Not Exist" });
    expect(getSkillActivity("conv-1")?.loaded).toEqual([]);
  });

  it("records nothing when the call carries no conversation id", async () => {
    recordSkillActivity("conv-1", { auto: [], deferred: [] });
    await runInConversation(undefined, { name: "Verify Before Push" });
    expect(getSkillActivity("conv-1")?.loaded).toEqual([]);
  });
});

// ============================================================
// Untrusted-content wrapping (injection defence)
// ============================================================
// Repository text reaches the model through exactly one seam. These
// tests pin that the seam wraps content-carrying tools, leaves control
// results alone, and never nests tags.

describe("serializeToolResult", () => {
  function result(
    name: string,
    data: unknown
  ): Parameters<typeof serializeToolResult>[0] {
    return { callId: "c1", name, ok: true, data, durationMs: 1 } as Parameters<
      typeof serializeToolResult
    >[0];
  }

  it("wraps repository content in untrusted tags", () => {
    const text = serializeToolResult(result("read_file", { path: "a.ts", content: "x" }));
    expect(text.startsWith('<untrusted-content source="read_file">')).toBe(true);
    expect(text.trimEnd().endsWith("</untrusted-content>")).toBe(true);
    expect(text).toContain('"path":"a.ts"');
  });

  it("does not wrap a control result", () => {
    const text = serializeToolResult(result("remember", { status: "recorded" }));
    expect(text).not.toContain("untrusted-content");
  });

  it("never nests tags when text is wrapped again", () => {
    const once = wrapUntrusted("read_file", '{"content":"x"}');
    expect(wrapUntrusted("read_file", once)).toBe(once);
    expect((once.match(/<untrusted-content/g) ?? [])).toHaveLength(1);
  });

  it("keeps a truncation marker inside the tags", () => {
    const huge = "y".repeat(30_000);
    const text = serializeToolResult(result("search_workspace", { hits: huge }));
    expect(text).toMatch(/truncated/);
    expect(text.indexOf("[truncated")).toBeGreaterThan(text.indexOf("<untrusted-content"));
    expect(text.trimEnd().endsWith("</untrusted-content>")).toBe(true);
  });
});
