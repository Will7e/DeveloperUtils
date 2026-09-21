// ============================================================
// Tool Repair — Regression Tests
// ============================================================
// Every case here is a real failure shape produced by a cheap model
// through OpenRouter. The point of the suite is that the model does
// not have to be good for the harness to behave well.

import { describe, it, expect } from "vitest";
import {
  callSignature,
  extractBalancedSpan,
  extractTextToolCalls,
  recoveredToolCalls,
  refuseResultText,
  repairToolArguments,
  repeatDecision,
  reuseResultText,
  stripCodeFences,
  type CallLedgerEntry,
} from "./tool-repair";

const KNOWN = new Set(["read_file", "write_file", "search_code", "list_repo_files"]);

describe("stripCodeFences", () => {
  it("unwraps a complete fenced block", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("unwraps a fence that was never closed", () => {
    expect(stripCodeFences('```json\n{"a":1')).toBe('{"a":1');
  });

  it("leaves unfenced text alone", () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("extractBalancedSpan", () => {
  it("ignores braces inside strings", () => {
    expect(extractBalancedSpan('x {"a":"}{"} y')).toBe('{"a":"}{"}');
  });

  it("handles nested objects", () => {
    expect(extractBalancedSpan('{"a":{"b":1}}')).toBe('{"a":{"b":1}}');
  });

  it("returns null when there is no span", () => {
    expect(extractBalancedSpan("no json here")).toBeNull();
  });
});

describe("repairToolArguments", () => {
  it("passes clean JSON through untouched", () => {
    const out = repairToolArguments('{"path":"src/a.ts"}');
    expect(out.args).toEqual({ path: "src/a.ts" });
    expect(out.repaired).toBe(false);
  });

  it("treats empty input as an argument-less call", () => {
    expect(repairToolArguments("")).toEqual({ args: {}, repaired: false });
  });

  it("strips a code fence", () => {
    const out = repairToolArguments('```json\n{"path":"a.ts"}\n```');
    expect(out.args).toEqual({ path: "a.ts" });
    expect(out.repaired).toBe(true);
  });

  it("pulls the object out of surrounding prose", () => {
    const out = repairToolArguments('Sure! Here it is: {"path":"a.ts"} — done.');
    expect(out.args).toEqual({ path: "a.ts" });
    expect(out.note).toMatch(/extracted/i);
  });

  it("removes a trailing comma", () => {
    expect(repairToolArguments('{"path":"a.ts",}').args).toEqual({ path: "a.ts" });
  });

  it("converts Python/JS literals JSON rejects", () => {
    expect(repairToolArguments('{"replaceAll": True}').args).toEqual({ replaceAll: true });
    expect(repairToolArguments('{"x": None}').args).toEqual({ x: null });
  });

  it("converts single-quoted payloads when no double quote exists", () => {
    expect(repairToolArguments("{'path': 'src/a.ts'}").args).toEqual({ path: "src/a.ts" });
  });

  it("closes a payload truncated mid-string by the stream", () => {
    const out = repairToolArguments('{"path":"src/a.ts","content":"export const x = 1;');
    expect(out.args).toEqual({ path: "src/a.ts", content: "export const x = 1;" });
    expect(out.note).toMatch(/truncated/i);
  });

  it("returns null for unrecoverable input", () => {
    expect(repairToolArguments("not json at all").args).toBeNull();
  });

  it("rejects a top-level array (arguments must be an object)", () => {
    expect(repairToolArguments('["a"]').args).toBeNull();
  });
});

describe("extractTextToolCalls", () => {
  it("recovers a call wrapped in tool_call tags", () => {
    const calls = extractTextToolCalls(
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
      KNOWN
    );
    expect(calls).toEqual([{ name: "read_file", arguments: '{"path":"a.ts"}' }]);
  });

  it("recovers a call from a fenced json block", () => {
    const calls = extractTextToolCalls(
      'I will read it:\n```json\n{"name":"read_file","arguments":{"path":"b.ts"}}\n```',
      KNOWN
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
  });

  it("recovers the OpenAI-nested shape", () => {
    const calls = extractTextToolCalls(
      '<function_call>{"function":{"name":"search_code","arguments":"{\\"query\\":\\"foo\\"}"}}</function_call>',
      KNOWN
    );
    expect(calls).toEqual([{ name: "search_code", arguments: '{"query":"foo"}' }]);
  });

  it("accepts the {tool, args} alias", () => {
    const calls = extractTextToolCalls('{"tool":"list_repo_files","args":{}}', KNOWN);
    expect(calls).toEqual([{ name: "list_repo_files", arguments: "{}" }]);
  });

  it("ignores an object naming an unknown tool", () => {
    expect(extractTextToolCalls('{"name":"drop_database","arguments":{}}', KNOWN)).toEqual([]);
  });

  it("ignores prose that merely mentions a tool", () => {
    expect(extractTextToolCalls("You should use read_file to inspect that.", KNOWN)).toEqual([]);
  });

  it("deduplicates identical recovered calls", () => {
    const calls = extractTextToolCalls(
      '{"name":"read_file","arguments":{"path":"a.ts"}}\n{"name":"read_file","arguments":{"path":"a.ts"}}',
      KNOWN
    );
    expect(calls).toHaveLength(1);
  });

  it("caps recovery at eight calls", () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `{"name":"read_file","arguments":{"path":"f${i}.ts"}}`
    ).join("\n");
    expect(extractTextToolCalls(many, KNOWN)).toHaveLength(8);
  });
});

describe("recoveredToolCalls", () => {
  it("mints paired ids for the wire protocol", () => {
    const calls = recoveredToolCalls([{ name: "read_file", arguments: "{}" }]);
    expect(calls).toEqual([{ id: "recovered_0", name: "read_file", arguments: "{}" }]);
  });
});

describe("callSignature", () => {
  it("is stable across argument key order", () => {
    expect(callSignature("write_file", '{"b":2,"a":1}')).toBe(
      callSignature("write_file", '{"a":1,"b":2}')
    );
  });

  it("differs when an argument value differs", () => {
    expect(callSignature("read_file", '{"path":"a"}')).not.toBe(
      callSignature("read_file", '{"path":"b"}')
    );
  });

  it("falls back to raw text when arguments cannot be parsed", () => {
    expect(callSignature("read_file", "garbage")).toBe("read_file\u0000garbage");
  });
});

describe("repeatDecision", () => {
  const ok: CallLedgerEntry = { count: 2, ok: true, digest: "src/a.ts" };
  const bad: CallLedgerEntry = { count: 2, ok: false, digest: "oldString not found" };

  it("executes an unseen call", () => {
    expect(repeatDecision(undefined)).toEqual({ action: "execute" });
  });

  it("executes the first repeat (a read legitimately repeats after an edit)", () => {
    expect(repeatDecision({ count: 1, ok: true })).toEqual({ action: "execute" });
  });

  it("reuses the result of a long-successful call instead of re-running it", () => {
    const decision = repeatDecision(ok);
    expect(decision.action).toBe("reuse");
  });

  it("refuses a call that has already failed twice", () => {
    const decision = repeatDecision(bad);
    expect(decision.action).toBe("refuse");
  });
});

describe("model-facing repair text", () => {
  it("tells the model the result is reused, not re-run", () => {
    const text = reuseResultText({ count: 2, ok: true, resultText: "file body" });
    expect(text).toContain("file body");
    expect(text).toMatch(/Do not repeat this call/);
  });

  it("demands a changed approach for a repeated failure", () => {
    const text = refuseResultText({ count: 2, ok: false, digest: "no match" }, "edit_file");
    expect(text).toContain("no match");
    expect(text).toMatch(/Change your approach/);
  });
});
