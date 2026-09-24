// ============================================================
// Activity — tests
// ============================================================
// The rail's whole job is to be RIGHT about what is happening, so these cases
// pin the precedence between the facts it reduces: a pending call outranks
// prose, a parked turn is not idle, and an unparseable argument string costs a
// target rather than the phase.

import { describe, expect, it } from "vitest";
import { deriveActivity, justFinished, targetOf, type ActivityInput } from "./activity";
import type { ChatMessage, ToolCallRequest } from "../types";

function call(id: string, name: ToolCallRequest["name"], args: string): ToolCallRequest {
  return { id, name, arguments: args };
}

function callsMessage(id: string, calls: ToolCallRequest[], at = 1000): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: at,
    toolCalls: { kind: "tool_calls", calls },
  };
}

function resultMessage(id: string, callId: string): ChatMessage {
  return {
    id,
    role: "user",
    content: "",
    timestamp: 1100,
    toolResult: { kind: "tool_result", callId, name: "read_file", ok: true, content: "{}", durationMs: 5 },
  };
}

function prose(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, timestamp: 900 };
}

function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    isStreaming: true,
    reconnecting: false,
    streamingContent: "",
    streamingReasoning: "",
    messages: [],
    ...overrides,
  };
}

describe("deriveActivity — precedence between facts", () => {
  it("is idle when nothing is running", () => {
    const activity = deriveActivity(input({ isStreaming: false }));
    expect(activity.phase).toBe("idle");
    expect(activity.busy).toBe(false);
    expect(activity.key).toBe("idle");
  });

  it("names the pending call, its target and its position in the group", () => {
    const activity = deriveActivity(
      input({
        messages: [
          callsMessage("m1", [
            call("c1", "read_file", '{"path":"src/app.tsx"}'),
            call("c2", "edit_file", '{"path":"src/api/client.ts","old_string":"a"}'),
          ]),
          resultMessage("r1", "c1"),
        ],
      })
    );
    expect(activity.phase).toBe("editing");
    expect(activity.verb).toBe("Editing");
    expect(activity.target).toBe("src/api/client.ts");
    expect(activity.stepIndex).toBe(2);
    expect(activity.stepTotal).toBe(2);
    expect(activity.since).toBe(1000);
  });

  it("prefers the pending call over streamed prose — a diff being written outranks a paragraph", () => {
    const activity = deriveActivity(
      input({
        streamingContent: "I'll update the client now",
        messages: [callsMessage("m1", [call("c1", "write_file", '{"path":"src/a.ts"}')])],
      })
    );
    expect(activity.phase).toBe("writing");
    expect(activity.target).toBe("src/a.ts");
  });

  it("stops pairing at the next step group, so a finished group is not 'pending'", () => {
    const activity = deriveActivity(
      input({
        messages: [
          callsMessage("m1", [call("c1", "read_file", '{"path":"a.ts"}')]),
          resultMessage("r1", "c1"),
          callsMessage("m2", [call("c2", "run_checks", "{}")]),
          resultMessage("r2", "c2"),
        ],
        streamingReasoning: "thinking hard",
      })
    );
    // Every call is answered, so the fallback chain applies.
    expect(activity.phase).toBe("thinking");
    expect(activity.stepTotal).toBe(0);
  });

  it("reports thinking while reasoning streams and no prose has started", () => {
    const activity = deriveActivity(input({ streamingReasoning: "Let me consider…" }));
    expect(activity.phase).toBe("thinking");
    expect(activity.verb).toBe("Thinking");
  });

  it("switches to writing once prose arrives, even with reasoning in front of it", () => {
    const activity = deriveActivity(
      input({ streamingReasoning: "Let me consider…", streamingContent: "Here is the fix" })
    );
    expect(activity.phase).toBe("writing");
  });

  it("treats a parked turn as busy rather than idle", () => {
    const activity = deriveActivity(input({ isStreaming: false, waitingForUser: true }));
    expect(activity.phase).toBe("waiting");
    expect(activity.busy).toBe(true);
  });

  it("announces a reconnect ahead of the phase it interrupted", () => {
    const activity = deriveActivity(input({ reconnecting: true, streamingContent: "partial" }));
    expect(activity.key).toBe("reconnecting");
  });

  it("announces a user-run check ahead of everything else", () => {
    const activity = deriveActivity(input({ runningChecks: true, streamingReasoning: "x" }));
    expect(activity.phase).toBe("verifying");
    expect(activity.key).toBe("checks");
  });

  it("names the active plan step while the turn is starting with nothing else to say", () => {
    const activity = deriveActivity(
      input({
        plan: {
          updatedAt: 5,
          complete: false,
          steps: [
            { id: "s1", text: "Read the poller", status: "done" },
            { id: "s2", text: "Add backoff", status: "active" },
          ],
        },
      })
    );
    expect(activity.verb).toBe("Working the plan");
    expect(activity.target).toBe("Add backoff");
    expect(activity.stepTotal).toBe(2);
  });

  it("gives each activity a distinct key, so an elapsed clock resets on a change", () => {
    const a = deriveActivity(input({ streamingReasoning: "x" }));
    const b = deriveActivity(input({ streamingContent: "y" }));
    const c = deriveActivity(input({ messages: [callsMessage("m1", [call("c1", "read_file", '{"path":"a.ts"}')])] }));
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
  });
});

describe("targetOf — the one thing worth naming", () => {
  it("reads a path", () => {
    expect(targetOf('{"path":"src/a.ts"}')).toBe("src/a.ts");
  });

  it("quotes a query so it cannot be mistaken for a path", () => {
    expect(targetOf('{"query":"useEffect"}')).toBe("“useEffect”");
  });

  it("summarises a batched read instead of printing every path", () => {
    expect(targetOf('{"paths":["a.ts","b.ts","c.ts"]}')).toBe("a.ts +2 more");
  });

  it("passes a single batched path through unchanged", () => {
    expect(targetOf('{"paths":["a.ts"]}')).toBe("a.ts");
  });

  it("truncates into a directory marker for a subtree walk", () => {
    expect(targetOf('{"subtree":"src/features"}')).toBe("src/features/");
  });

  it("names what an MCP or app-surface call invokes", () => {
    expect(targetOf('{"tool":"merge_pr"}')).toBe("merge_pr");
    expect(targetOf('{"action":"set_theme"}')).toBe("set_theme");
  });

  it("returns nothing for empty, malformed or non-object arguments", () => {
    expect(targetOf("")).toBe("");
    expect(targetOf('{"path":"src/a.t')).toBe("");
    expect(targetOf("[1,2]")).toBe("");
    expect(targetOf("null")).toBe("");
  });

  it("ignores non-string values rather than stringifying them", () => {
    expect(targetOf('{"path":42}')).toBe("");
  });
});

describe("justFinished", () => {
  it("fires only on the busy → idle edge", () => {
    const busy = deriveActivity(input({ streamingReasoning: "x" }));
    const idle = deriveActivity(input({ isStreaming: false }));
    expect(justFinished(busy, idle)).toBe(true);
    expect(justFinished(idle, idle)).toBe(false);
    expect(justFinished(busy, busy)).toBe(false);
  });
});

describe("pending call detection ignores prose-only transcripts", () => {
  it("falls back to prose for a conversation of plain messages", () => {
    const activity = deriveActivity(input({ messages: [prose("p1", "hello"), prose("p2", "there")] }));
    expect(activity.phase).toBe("thinking");
    expect(activity.stepTotal).toBe(0);
  });
});
