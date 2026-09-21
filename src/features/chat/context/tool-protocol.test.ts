// ============================================================
// Tool Protocol — Wire Shape Regression Tests
// ============================================================
// Agent mode sends an assistant message with `tool_calls`. Strict
// providers (OpenAI, Groq, Fireworks, vLLM…) reject a request when
// those calls are not answered by `role:"tool"` messages carrying the
// matching `tool_call_id` — the 400 arrived only on whichever
// provider the router happened to pick, so this pins the contract:
//
//  - a result is a `tool` row bound to its call id, never user text
//  - an assistant call with no result in the slice is dropped (and
//    degrades to plain text, or disappears when it has none)
//  - a result whose call was cropped is dropped
//  - a request never OPENS with a tool row
//  - folding a stale result keeps the pairing, only shortening text

import { describe, it, expect } from "vitest";
import { sanitizeToolProtocol, staleToolResultIds, prepareRequest, type WireMessage } from "./engine";
import { toWireBodyMessage } from "../lib/openrouter-client";
import type { ChatConversation, ChatMessage, ToolCallRequest } from "../types";

let seq = 0;
function uid(): string {
  seq += 1;
  return `m${seq}`;
}

function user(content: string): ChatMessage {
  return { id: uid(), role: "user", content, timestamp: seq };
}

function assistant(content: string, calls?: ToolCallRequest[]): ChatMessage {
  return {
    id: uid(),
    role: "assistant",
    content,
    timestamp: seq,
    ...(calls ? { toolCalls: { kind: "tool_calls" as const, calls } } : {}),
  };
}

function result(callId: string, name: ToolCallRequest["name"], content = "{}"): ChatMessage {
  return {
    id: uid(),
    role: "user",
    content: "",
    timestamp: seq,
    toolResult: { kind: "tool_result", callId, name, ok: true, content, durationMs: 1 },
  };
}

function call(id: string, name: ToolCallRequest["name"] = "read_file"): ToolCallRequest {
  return { id, name, arguments: '{"path":"src/App.tsx"}' };
}

describe("sanitizeToolProtocol", () => {
  it("keeps an answered exchange intact", () => {
    const messages = [
      user("read the file"),
      assistant("", [call("c1")]),
      result("c1", "read_file"),
      assistant("done"),
    ];
    const out = sanitizeToolProtocol(messages);
    expect(out).toHaveLength(4);
    expect(out[2]!.toolResult?.callId).toBe("c1");
  });

  it("drops an unanswered assistant call but keeps its prose", () => {
    const messages = [user("go"), assistant("thinking out loud", [call("c1")])];
    const out = sanitizeToolProtocol(messages);
    expect(out).toHaveLength(2);
    expect(out[1]!.toolCalls).toBeUndefined();
    expect(out[1]!.content).toBe("thinking out loud");
  });

  it("removes an unanswered assistant call that has no prose at all", () => {
    const messages = [user("go"), assistant("", [call("c1")])];
    const out = sanitizeToolProtocol(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });

  it("keeps only the answered calls of a multi-call turn", () => {
    const a = assistant("", [call("c1"), call("c2")]);
    const messages = [user("go"), a, result("c2", "list_repo_files")];
    const out = sanitizeToolProtocol(messages);
    expect(out[1]!.toolCalls?.calls.map((c) => c.id)).toEqual(["c2"]);
    expect(out[2]!.toolResult?.callId).toBe("c2");
  });

  it("drops a result whose call was cropped away", () => {
    const messages = [user("go"), result("c1", "read_file"), assistant("done")];
    const out = sanitizeToolProtocol(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("never lets a request open with a tool row", () => {
    const messages = [result("c1", "read_file"), assistant("carry on")];
    const out = sanitizeToolProtocol(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("carry on");
  });

  it("does not mutate the input messages", () => {
    const a = assistant("prose", [call("c1")]);
    const messages = [user("go"), a, assistant("later")];
    sanitizeToolProtocol(messages);
    expect(a.toolCalls?.calls).toHaveLength(1);
    expect(a.content).toBe("prose");
  });
});

describe("prepareRequest wire shape", () => {
  const conversation: ChatConversation = {
    id: "conv-1",
    title: "agent",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
  };

  function wireFor(messages: ChatMessage[]): WireMessage[] {
    const prepared = prepareRequest({
      conversation: { ...conversation, messages },
      effectiveSystemPrompt: "system",
      modelId: "openai/gpt-oss-120b:free",
    });
    return prepared.messages as WireMessage[];
  }

  it("emits role:'tool' rows bound to the call id (not user text)", () => {
    const messages = [
      user("read it"),
      assistant("", [call("call_abc")]),
      result("call_abc", "read_file", '{"content":"hi"}'),
      assistant("The file says hi."),
    ];
    const wire = wireFor(messages);

    const assistantTurn = wire.find((m) => m.tool_calls !== undefined);
    expect(assistantTurn?.tool_calls?.[0]?.id).toBe("call_abc");

    const toolRow = wire.find((m) => m.role === "tool");
    expect(toolRow).toBeDefined();
    expect(toolRow!.tool_call_id).toBe("call_abc");
    expect(toolRow!.content).toBe('{"content":"hi"}');
    // No user row may carry the tool payload any more.
    expect(wire.some((m) => m.role === "user" && String(m.content).includes("Tool result"))).toBe(false);
  });

  it("serializes tool fields into the request body", () => {
    const body = toWireBodyMessage({
      role: "tool",
      content: "ok",
      tool_call_id: "call_abc",
    });
    expect(body).toEqual({ role: "tool", content: "ok", tool_call_id: "call_abc" });

    const assistantBody = toWireBodyMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    expect(assistantBody.tool_calls).toHaveLength(1);
    expect(assistantBody.tool_call_id).toBeUndefined();
  });

  it("keeps folding stale results but preserves the pairing", () => {
    const messages: ChatMessage[] = [user("go")];
    for (let i = 0; i < 8; i++) {
      const id = `c${i}`;
      messages.push(assistant(`step ${i}`, [call(id)]));
      messages.push(result(id, "read_file", "X".repeat(500)));
      messages.push(assistant(`after ${i}`));
    }
    // Keep the newest result visible (its assistant turn is inside the
    // fold window) so at least one pair survives.
    const stale = staleToolResultIds(messages);
    const wire = wireFor(messages);
    const toolRows = wire.filter((m) => m.role === "tool");
    expect(toolRows.length).toBeGreaterThan(0);
    for (const row of toolRows) {
      expect(typeof row.tool_call_id).toBe("string");
      expect(row.tool_call_id).not.toBe("");
    }
    // A folded row is shortened, never retyped.
    const folded = wire.filter((m) => m.role === "tool" && !String(m.content).startsWith("X"));
    expect(folded.length).toBeGreaterThan(0);
    expect(stale.size).toBeGreaterThan(0);
  });
});
