// ============================================================
// Argument Coercion — The Call The Model Meant To Make
// ============================================================
// The first test in this file is the reported bug, verbatim: a request whose
// `headers` arrived as a JSON string, which used to come back as
// `Argument "headers" must be of type object, got string.` and cost the user a
// turn and a manual correction.

import { describe, it, expect } from "vitest";
import { coerceArguments } from "./arg-coercion";
import { getToolMeta, validateToolCall } from "./tool-registry";

const httpWrite = () => getToolMeta("http_write")!.parameters;

describe("the reported failure", () => {
  it("reads stringified headers as the object they are", () => {
    const out = coerceArguments(httpWrite(), {
      method: "GET",
      url: "https://api.example.com/orders",
      headers: '{"Accept":"application/json"}',
    });
    expect(out.args.headers).toEqual({ Accept: "application/json" });
    expect(out.notes.join(" ")).toContain("headers");
  });

  it("accepts a stringified object through validation end to end", () => {
    // POST, because http_write's own enumeration refuses GET — that is
    // http_request's job, and conflating the two is the other half of the
    // reported transcript.
    const raw = JSON.stringify({
      method: "POST",
      url: "https://api.example.com/orders",
      headers: '{"Accept":"application/json"}',
    });
    const result = validateToolCall("http_write", raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.headers).toEqual({ Accept: "application/json" });
    expect(result.notes.length).toBe(1);
  });

  it("tolerates the trailing comma models write inside the string", () => {
    const raw = JSON.stringify({
      method: "POST",
      url: "https://x.test",
      headers: '{"Accept":"application/json",}',
    });
    const result = validateToolCall("http_write", raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.headers).toEqual({ Accept: "application/json" });
  });

  it("still reports a precise error when the string is not JSON at all", () => {
    const raw = JSON.stringify({ method: "POST", url: "https://x.test", headers: "Accept: json" });
    const result = validateToolCall("http_write", raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("headers");
  });
});

describe("types the schema declares", () => {
  const schema = () => getToolMeta("ask_user")!.parameters;

  it("reads a numeric string as a number", () => {
    const out = coerceArguments(
      { type: "object", properties: { timeoutMs: { type: "number" } } },
      { timeoutMs: "30000" }
    );
    expect(out.args.timeoutMs).toBe(30000);
    expect(out.notes.length).toBe(1);
  });

  it("reads a boolean string as a boolean", () => {
    const out = coerceArguments(
      { type: "object", properties: { replaceAll: { type: "boolean" } } },
      { replaceAll: "true" }
    );
    expect(out.args.replaceAll).toBe(true);
  });

  it("matches an enum case-insensitively and sends the canonical value", () => {
    const out = coerceArguments(schema(), {
      header: "H",
      question: "Which one?",
      multiSelect: "False",
      options: [{ label: "A" }],
    });
    expect(out.args.multiSelect).toBe(false);
  });

  it("reads an empty string as an empty object for an object field", () => {
    const out = coerceArguments(
      { type: "object", properties: { headers: { type: "object" } } },
      { headers: "" }
    );
    expect(out.args.headers).toEqual({});
  });

  it("reads a stringified array as an array", () => {
    const out = coerceArguments(
      { type: "object", properties: { options: { type: "array", items: { type: "object" } } } },
      { options: '[{"label":"A"}]' }
    );
    expect(out.args.options).toEqual([{ label: "A" }]);
  });

  it("coerces inside a nested object and its array items", () => {
    const out = coerceArguments(
      {
        type: "object",
        properties: {
          plan: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done"] } },
            },
          },
        },
      },
      { plan: [{ text: "step", status: "ACTIVE" }] }
    );
    expect(out.args.plan).toEqual([{ text: "step", status: "active" }]);
  });
});

describe("what must NOT be touched", () => {
  it("never coerces a field the schema declares as a string", () => {
    // This is the rule that protects file content: a patch that happens to look
    // like JSON is text, and turning it into an object would corrupt the write.
    const schema = getToolMeta("edit_file")!.parameters;
    const newString = '{"looks":"like json"}';
    const out = coerceArguments(schema, {
      path: "src/a.ts",
      oldString: "const x = 1;",
      newString,
    });
    expect(out.args.newString).toBe(newString);
    expect(out.notes).toEqual([]);
  });

  it("never coerces the body string of an http_write", () => {
    const body = '{"name":"x"}';
    const out = coerceArguments(httpWrite(), { method: "POST", url: "https://x.test", body });
    expect(out.args.body).toBe(body);
  });

  it("returns the SAME object when nothing needed repairing", () => {
    const args = { path: "src/a.ts", startLine: 1 };
    const out = coerceArguments(getToolMeta("read_file")!.parameters, args);
    expect(out.args).toBe(args);
    expect(out.notes).toEqual([]);
  });

  it("leaves an unknown extra property alone rather than inventing a type", () => {
    const out = coerceArguments(httpWrite(), { method: "GET", url: "https://x.test", futureFlag: "yes" });
    expect(out.args.futureFlag).toBe("yes");
  });
});
