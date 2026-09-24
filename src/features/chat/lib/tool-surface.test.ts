import { describe, it, expect } from "vitest";
import { argumentRepairNote, withContractHint, withheldRefusal } from "./tool-surface";
import type { ToolCallResult } from "../types";

const offered = (...names: string[]) => new Set(names);

const failure = (over: Partial<ToolCallResult> = {}): ToolCallResult => ({
  callId: "c1",
  name: "http_write",
  ok: false,
  data: { error: 'Argument "headers" must be of type object, got string.' },
  durationMs: 3,
  summary: "invalid arguments",
  ...over,
});

describe("withheldRefusal", () => {
  it("says nothing about a tool the turn offered", () => {
    expect(withheldRefusal("http_write", offered("http_write", "http_request"))).toBeNull();
  });

  it("leaves an unknown name to the registry's own message", () => {
    expect(withheldRefusal("not_a_tool", offered("read_file"))).toBeNull();
  });

  it("refuses a real tool that was not offered, and names the sibling", () => {
    const message = withheldRefusal("http_write", offered("http_request", "run_code"));
    expect(message).toBeTruthy();
    expect(message!).toContain("http_write");
    expect(message!).toContain("http_request");
    // The sibling's own canonical call, so the next move is obvious.
    expect(message!).toContain("http_request({");
  });

  it("lists what IS available when the sibling is not offered either", () => {
    const message = withheldRefusal("push_changes", offered("read_file", "search_workspace", "run_code"));
    expect(message!).toContain("push_changes");
    expect(message!).toContain("read_file");
    expect(message!).toContain("run_code");
  });

  it("explains that repeating it cannot help", () => {
    const message = withheldRefusal("create_diagram", offered("run_code"))!;
    expect(message).toMatch(/again will not change that/i);
  });
});

describe("withContractHint", () => {
  it("attaches the contract to a repeat failure without losing the error", () => {
    const enriched = withContractHint(failure());
    const payload = enriched.data as Record<string, unknown>;
    expect(payload.error).toContain('Argument "headers"');
    expect(String(payload.hint)).toContain("already failed once");
    // the sibling, spelled out
    expect(String(payload.hint)).toContain("http_request");
  });

  it("leaves a successful result untouched", () => {
    const ok = failure({ ok: true, data: { status: 200 }, summary: "GET https://x.test" });
    expect(withContractHint(ok)).toBe(ok);
  });

  it("does not mutate the original payload", () => {
    const original = failure();
    withContractHint(original);
    expect((original.data as Record<string, unknown>).hint).toBeUndefined();
  });

  it("copes with a payload that is not an object", () => {
    const enriched = withContractHint(failure({ data: "boom" }));
    const payload = enriched.data as Record<string, unknown>;
    expect(payload.error).toBe("boom");
    expect(payload.hint).toBeTruthy();
  });
});

describe("argumentRepairNote", () => {
  it("is empty when nothing was repaired", () => {
    expect(argumentRepairNote([])).toBe("");
  });

  it("names the repair", () => {
    const note = argumentRepairNote(['"headers" was sent as a JSON string and read as an object']);
    expect(note).toContain("arguments repaired");
    expect(note).toContain("headers");
  });

  it("counts several repairs", () => {
    expect(argumentRepairNote(["a", "b"])).toContain("(2)");
  });
});
