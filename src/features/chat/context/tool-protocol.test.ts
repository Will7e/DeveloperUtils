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
import {
  foldedTurnCutoff,
  sanitizeToolProtocol,
  staleToolResultIds,
  prepareRequest,
  type WireMessage,
} from "./engine";
import { TOOL_RESULT_FOLD_QUANTUM, TOOL_RESULT_FOLD_TURNS } from "../constants";
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
    // Long enough to fold at all under the QUANTIZED boundary: the cut is
    // floor(excess / QUANTUM) * QUANTUM, so it stays 0 until the conversation is
    // TOOL_RESULT_FOLD_TURNS + QUANTUM transcript turns deep. (Only the rows that
    // carry prose count as turns — a tool-calls assistant row and its result are
    // protocol rows.) A fixture sized for the old flat rule folds nothing.
    for (let i = 0; i < 12; i++) {
      const id = `c${i}`;
      messages.push(assistant(`step ${i}`, [call(id)]));
      messages.push(result(id, "read_file", "X".repeat(500)));
      messages.push(assistant(`after ${i}`));
    }
    // Keep the newest results visible (their assistant turns are inside the
    // fold window) so most pairs survive unfolded.
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

// ============================================================
// Fold boundary quantization — the prompt-cache contract
// ============================================================
// Folding rewrites the front of the wire message list, which is the region a
// provider caches. If the boundary moves one turn at a time, the prefix differs
// on every turn and no cache hit is possible for the whole conversation. These
// tests pin the step behaviour, because a well-meaning "simplification" back to
// a flat threshold would silently undo the caching work and nothing else would
// notice.

/**
 * A conversation of exactly `turns` TRANSCRIPT turns, each with one folded
 * candidate result. Only the `user` row counts as a transcript turn — the
 * tool-calls assistant row and its result are protocol rows — which keeps the
 * ordinal arithmetic in these tests legible.
 */
function conversationOf(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    // Deterministic ids, NOT the shared uid() counter: these tests compare the
    // folded set across two lengths of the same conversation, which is only
    // meaningful if the same logical message keeps the same id.
    messages.push({ id: `t${i}-user`, role: "user", content: `turn ${i}`, timestamp: i });
    messages.push({
      id: `t${i}-call`,
      role: "assistant",
      content: "",
      timestamp: i,
      toolCalls: { kind: "tool_calls" as const, calls: [call(`c${i}`)] },
    });
    messages.push({
      id: `t${i}-result`,
      role: "user",
      content: "",
      timestamp: i,
      toolResult: {
        kind: "tool_result" as const,
        callId: `c${i}`,
        name: "read_file" as const,
        ok: true,
        content: `payload-${i}`,
        durationMs: 1,
      },
    });
  }
  return messages;
}

/** The transcript-turn ordinal the fold cut sits at */
const cutoffOf = (turns: number) => foldedTurnCutoff(turns);

describe("foldedTurnCutoff", () => {
  it("folds nothing until the conversation is past the threshold", () => {
    expect(foldedTurnCutoff(0)).toBe(0);
    expect(foldedTurnCutoff(TOOL_RESULT_FOLD_TURNS)).toBe(0);
    expect(foldedTurnCutoff(TOOL_RESULT_FOLD_TURNS + 1)).toBe(0);
  });

  it("holds the cut still for a full quantum of turns, then moves", () => {
    // The property that makes caching possible: the conversation grows by
    // QUANTUM turns and the front of the message list is byte-identical.
    //
    // The first fold lands at excess = QUANTUM, and the plateau that opens there
    // is EXACTLY QUANTUM turns long — hence the assertion one turn past the end.
    // A wider step would be a bigger lag than the documented bound, and a
    // narrower one would move the prefix more often than this design promises.
    const firstFolding = TOOL_RESULT_FOLD_TURNS + TOOL_RESULT_FOLD_QUANTUM;
    const start = foldedTurnCutoff(firstFolding);
    expect(start).toBeGreaterThan(0);
    for (let i = 0; i < TOOL_RESULT_FOLD_QUANTUM; i++) {
      expect(foldedTurnCutoff(firstFolding + i)).toBe(start);
    }
    expect(foldedTurnCutoff(firstFolding + TOOL_RESULT_FOLD_QUANTUM)).toBe(
      start + TOOL_RESULT_FOLD_QUANTUM
    );
  });

  it("advances the cut by exactly one quantum when it does move", () => {
    let previous = foldedTurnCutoff(0);
    const moves: number[] = [];
    for (let turns = 1; turns <= 80; turns++) {
      const current = foldedTurnCutoff(turns);
      if (current !== previous) moves.push(current - previous);
      previous = current;
    }
    expect(moves.length).toBeGreaterThan(0);
    for (const delta of moves) expect(delta).toBe(TOOL_RESULT_FOLD_QUANTUM);
  });

  it("never moves the cut backwards, so nothing ever unfolds", () => {
    // Quantizing the WINDOW length instead of the cut looks equivalent and fails
    // exactly here: a window stepping 6 → 10 would unfurl four turns.
    let previous = foldedTurnCutoff(0);
    for (let turns = 1; turns <= 120; turns++) {
      const current = foldedTurnCutoff(turns);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it("never cuts further than the old flat rule would have", () => {
    // Quantization must be gentler, never harsher: the cut can lag the flat
    // boundary but must never pass it, or the fold would be more aggressive than
    // it was before this change.
    for (let turns = 0; turns <= 100; turns++) {
      expect(foldedTurnCutoff(turns)).toBeLessThanOrEqual(
        Math.max(0, turns - TOOL_RESULT_FOLD_TURNS)
      );
    }
  });
});

describe("staleToolResultIds under a quantized boundary", () => {
  it("folds nothing in a conversation shorter than the threshold", () => {
    expect(staleToolResultIds(conversationOf(3)).size).toBe(0);
    expect(staleToolResultIds(conversationOf(TOOL_RESULT_FOLD_TURNS)).size).toBe(0);
  });

  it("keeps the folded set IDENTICAL while the cut holds still", () => {
    // The cache contract, stated directly: across a quantum of growth the set of
    // rewritten messages does not change at all, so the request prefix does not
    // change either.
    const firstFolding = TOOL_RESULT_FOLD_TURNS + TOOL_RESULT_FOLD_QUANTUM;
    const cut = cutoffOf(firstFolding);
    expect(cut).toBeGreaterThan(0);
    const baseline = [...staleToolResultIds(conversationOf(firstFolding))];
    expect(baseline.length).toBe(cut);
    for (let extra = 1; extra < TOOL_RESULT_FOLD_QUANTUM; extra++) {
      expect([...staleToolResultIds(conversationOf(firstFolding + extra))]).toEqual(baseline);
    }
  });

  it("only ever folds MORE as the conversation grows, never less", () => {
    let previous = staleToolResultIds(conversationOf(TOOL_RESULT_FOLD_TURNS + 1));
    for (let turns = TOOL_RESULT_FOLD_TURNS + 2; turns <= 60; turns++) {
      const current = staleToolResultIds(conversationOf(turns));
      for (const id of previous) expect(current.has(id)).toBe(true);
      previous = current;
    }
  });

  it("folds whole exchanges, never a call without its result", () => {
    const messages = conversationOf(30);
    const stale = staleToolResultIds(messages);
    for (const id of stale) {
      const message = messages.find((m) => m.id === id)!;
      expect(message.toolResult).toBeDefined();
      expect(message.toolResult!.callId).toBeTruthy();
    }
  });

  it("still folds the far past in a long conversation", () => {
    const messages = conversationOf(30);
    const stale = staleToolResultIds(messages);
    expect(stale.size).toBeGreaterThan(0);
    const oldest = messages.find((m) => m.toolResult?.content === "payload-0");
    expect(oldest).toBeDefined();
    expect(stale.has(oldest!.id)).toBe(true);
  });

  it("keeps the most recent turns verbatim", () => {
    const messages = conversationOf(30);
    const stale = staleToolResultIds(messages);
    const newest = messages.find((m) => m.toolResult?.content === "payload-29");
    // The exchange the model is currently working with must never be a digest.
    expect(stale.has(newest!.id)).toBe(false);
  });
});
