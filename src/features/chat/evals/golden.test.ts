// ============================================================
// Golden Cases — The Suite Runs, And Cannot Rot
// ============================================================
// The cases themselves live in golden-cases.ts; this file makes them a test and
// guards the two ways such a suite dies quietly:
//
//   • it stops covering anything (cases deleted, expectations emptied, the
//     recorded repros dropped) — asserted below as a floor; and
//   • its expectations drift away from the live harness (a tool leaves a
//     profile, a contract loses its discriminator) — which is what running every
//     case actually catches.
//
// It also pins the drafter, because "turn a reported failure into a case" is
// the mechanism that keeps this file growing rather than being written once.

import { describe, expect, it } from "vitest";
import {
  GOLDEN_CASES,
  LEAN_SURFACE_AT_THE_TIME,
  LEAN_SURFACE_TODAY,
  casePrompt,
  caseSurface,
  checkCase,
  draftCaseFromConversation,
  formatCaseResults,
  goldenCaseSummary,
  runGoldenCases,
} from "./golden-cases";
import type { ChatConversation, ChatMessage, ToolName } from "../types";

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  return { id: Math.random().toString(36), timestamp: 0, content: "", ...over };
}

describe("the golden suite", () => {
  const results = runGoldenCases();

  it("holds every case", () => {
    expect(formatCaseResults(results)).toBe(`${GOLDEN_CASES.length} golden case(s) hold.`);
  });

  it("checks the cases individually, so a failure names its case", () => {
    for (const c of GOLDEN_CASES) {
      const result = checkCase(c);
      expect(result.failures, `${c.id}: ${result.failures.join("; ")}`).toEqual([]);
    }
  });

  it("covers the reported reproduction as a recorded case", () => {
    const repro = GOLDEN_CASES.find((c) => c.id === "endpoint-read");
    expect(repro).toBeDefined();
    expect(repro!.recorded?.called).toBe("http_write");
    expect(repro!.expect).toBe("http_request");
  });

  it("keeps a floor under its own size and shape", () => {
    const summary = goldenCaseSummary();
    expect(summary.total).toBeGreaterThanOrEqual(12);
    expect(summary.recorded).toBeGreaterThanOrEqual(1);
    // Both profiles and both repo states are exercised: a suite that only knows
    // the full profile would miss the bugs the lean surface produces.
    expect(new Set(GOLDEN_CASES.map((c) => c.profile)).size).toBe(2);
    expect(new Set(GOLDEN_CASES.map((c) => c.repoAttached)).size).toBe(2);
    expect(GOLDEN_CASES.some((c) => c.mode === "plan")).toBe(true);
  });

  it("gives every case a reason a reviewer can check", () => {
    for (const c of GOLDEN_CASES) {
      expect(c.why.length, c.id).toBeGreaterThan(20);
      expect(c.prompt.trim().length, c.id).toBeGreaterThan(0);
    }
  });

  it("never expects a tool it also forbids", () => {
    for (const c of GOLDEN_CASES) {
      expect(c.forbid ?? [], c.id).not.toContain(c.expect);
    }
  });
});

describe("the lean surface: a record of the report, and today's decision", () => {
  const live = () =>
    caseSurface({ id: "x", why: "y", prompt: "z", profile: "lean", repoAttached: true, expect: null });

  it("is still exactly the list this change was made against", () => {
    // A tool appearing here or disappearing from it is a capability change for
    // every free model, and it should be a deliberate one — which is what a
    // hand-written list at this end of the test enforces.
    expect([...live()].sort()).toEqual([...LEAN_SURFACE_TODAY].sort());
  });

  it("still gives a free model everything the reported turn could do", () => {
    // The report-time surface is evidence, not a wishlist: nothing it had may
    // be taken away, whatever else the profile gains.
    for (const name of LEAN_SURFACE_AT_THE_TIME) {
      expect(live(), `${name} was on the reported surface`).toContain(name);
    }
  });
});

describe("a case's prompt is the prompt the turn would send", () => {
  it("documents the expected tool and its sibling, for the lean profile", () => {
    const repro = GOLDEN_CASES.find((c) => c.id === "endpoint-read")!;
    const prompt = casePrompt(repro);
    expect(prompt).toContain("- http_request:");
    expect(prompt).toContain("http_write");
    expect(prompt).not.toContain("- http_write:");
  });

  it("keeps the repo block out of a turn with no repository", () => {
    const appOnly = GOLDEN_CASES.find((c) => !c.repoAttached)!;
    expect(casePrompt(appOnly)).not.toContain("# Repository Context");
  });
});

describe("drafting the next case from a real failure", () => {
  const tool = (name: string, args: Record<string, unknown>, id: string) => ({
    id,
    name: name as ToolName,
    arguments: JSON.stringify(args),
  });

  const transcript: ChatConversation = {
    id: "c1",
    title: "reported",
    createdAt: 0,
    updatedAt: 0,
    messages: [
      msg({ role: "user", content: "fetch data from this endpoint" }),
      msg({
        role: "assistant",
        toolCalls: {
          kind: "tool_calls",
          calls: [tool("http_write", { url: "https://x.test/a", headers: '{"Accept":"*/*"}' }, "c1")],
        },
      }),
      msg({
        role: "user",
        toolResult: {
          kind: "tool_result",
          callId: "c1",
          name: "http_write",
          ok: false,
          content: '{"error":"Argument \\"headers\\" must be of type object, got string."}',
          durationMs: 1,
        },
      }),
    ],
  };

  it("recovers the request, the call and the error", () => {
    const draft = draftCaseFromConversation(transcript);
    expect(draft).not.toBeNull();
    expect(draft!.prompt).toBe("fetch data from this endpoint");
    expect(draft!.recorded?.called).toBe("http_write");
    expect(draft!.recorded?.error).toContain("must be of type object");
  });

  it("says which fields a person must still supply", () => {
    const draft = draftCaseFromConversation(transcript)!;
    expect(draft.needs.join(" ")).toMatch(/surface/);
    expect(draft.needs.join(" ")).toMatch(/expect/);
  });

  it("drafts nothing from a clean conversation", () => {
    const clean: ChatConversation = {
      id: "c2",
      title: "fine",
      createdAt: 0,
      updatedAt: 0,
      messages: [msg({ role: "user", content: "hello" }), msg({ role: "assistant", content: "hi" })],
    };
    expect(draftCaseFromConversation(clean)).toBeNull();
  });
});
