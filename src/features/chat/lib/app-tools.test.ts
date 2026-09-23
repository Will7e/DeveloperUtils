// ============================================================
// App Tools — Executor Tests
// ============================================================
// These cover the seam between a model's arguments and the app's own
// engines: argument refusals (which the model reads and adapts to), the
// pass-through into the compiler/formatter, and the honest framing of what
// a green result does and does not prove.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/compiler.service", () => ({
  compilerService: {
    execute: vi.fn(),
    isReady: vi.fn(),
    initialize: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock("@/services/formatter.service", () => ({
  formatContent: vi.fn(),
}));

import { compilerService } from "@/services/compiler.service";
import { formatContent } from "@/services/formatter.service";
import {
  compareDataTool,
  diffTextTool,
  formatCodeTool,
  runCodeTool,
  searchLibraryTool,
} from "./app-tools";

const execute = vi.mocked(compilerService.execute);
const isReady = vi.mocked(compilerService.isReady);
const initialize = vi.mocked(compilerService.initialize);
const format = vi.mocked(formatContent);

beforeEach(() => {
  vi.clearAllMocks();
  isReady.mockResolvedValue(true);
  initialize.mockResolvedValue(undefined);
  execute.mockResolvedValue({
    stdout: "42",
    stderr: "",
    exitCode: 0,
    duration: 12,
    timestamp: 0,
  });
  format.mockResolvedValue({ success: true, formatted: "{}", error: undefined });
});

describe("run_code", () => {
  it("runs a snippet and reports the real exit code", async () => {
    const result = await runCodeTool({ language: "javascript", code: "console.log(6*7)" });
    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("console.log(6*7)", "javascript", {
      timeout: 10_000,
      stdin: "",
    });
    expect(result.data).toMatchObject({ language: "javascript", exitCode: 0, stdout: "42" });
  });

  it("refuses HTML with the reason, instead of a fake passing run", async () => {
    const result = await runCodeTool({ language: "html", code: "<p>hi</p>" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/HTML is previewed/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an unknown language and lists what CAN run", async () => {
    const result = await runCodeTool({ language: "rust", code: "fn main() {}" });
    expect(result.ok).toBe(false);
    const error = String((result.data as { error: string }).error);
    expect(error).toContain("javascript");
    expect(error).toContain("lua");
  });

  it("refuses empty code and oversized code", async () => {
    expect((await runCodeTool({ language: "javascript", code: "  " })).ok).toBe(false);
    const huge = await runCodeTool({ language: "javascript", code: "x".repeat(200_001) });
    expect(huge.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("initializes a cold runtime and says so in the result", async () => {
    isReady.mockResolvedValueOnce(false);
    const result = await runCodeTool({ language: "python", code: "print(1)" });
    expect(initialize).toHaveBeenCalledWith("python");
    expect(result.ok).toBe(true);
    expect(String((result.data as { note?: string }).note)).toMatch(/runtime had to load/);
  });

  it("reports a non-zero exit as a failed verification, not a passing run", async () => {
    execute.mockResolvedValueOnce({
      stdout: "",
      stderr: "TypeError: x is not a function",
      exitCode: 1,
      duration: 5,
      timestamp: 0,
    });
    const result = await runCodeTool({ language: "javascript", code: "x()" });
    expect(result.ok).toBe(true); // the CALL worked…
    expect(result.data).toMatchObject({
      exitCode: 1,
      verification: { status: "failed" },
      scope: expect.stringContaining("does not verify the repository"),
    }); // …the RUN did not
  });

  it("flags a timeout as having no output to read", async () => {
    execute.mockResolvedValueOnce({
      stdout: "",
      stderr: "⏱ Execution timed out after 10s",
      exitCode: 1,
      duration: 10_000,
      timestamp: 0,
    });
    const result = await runCodeTool({ language: "javascript", code: "while(1){}" });
    expect(result.data).toMatchObject({ timedOut: true });
    expect(String((result.data as { hint?: string }).hint)).toMatch(/NO output/);
  });

  it("refuses to start when the turn was already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCodeTool(
      { language: "javascript", code: "1" },
      { signal: controller.signal }
    );
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a runtime that fails to load as unverified", async () => {
    isReady.mockResolvedValueOnce(false);
    initialize.mockRejectedValueOnce(new Error("cdn unreachable"));
    const result = await runCodeTool({ language: "lua", code: "print(1)" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/unverified/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("clamps a requested timeout into the supported range", async () => {
    await runCodeTool({ language: "javascript", code: "1", timeoutMs: 999_999 });
    expect(execute).toHaveBeenCalledWith("1", "javascript", expect.objectContaining({ timeout: 60_000 }));
  });
});

describe("format_code", () => {
  it("returns the formatted text and whether anything changed", async () => {
    format.mockResolvedValueOnce({ success: true, formatted: '{\n  "a": 1\n}' });
    const result = await formatCodeTool({ language: "json", code: '{"a":1}' });
    expect(format).toHaveBeenCalledWith('{"a":1}', "json");
    expect(result.data).toMatchObject({ formatted: '{\n  "a": 1\n}', changed: true });
  });

  it("surfaces a formatter error instead of pretending it formatted", async () => {
    format.mockResolvedValueOnce({ success: false, formatted: "", error: "Unexpected token" });
    const result = await formatCodeTool({ language: "json", code: "{oops" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toContain("Unexpected token");
  });

  it("refuses a language it has no parser for", async () => {
    const result = await formatCodeTool({ language: "cobol", code: "DISPLAY 'x'." });
    expect(result.ok).toBe(false);
    expect(format).not.toHaveBeenCalled();
  });
});

describe("compare_data", () => {
  it("diffs two lists as sets, ignoring order", () => {
    const result = compareDataTool({ mode: "list", a: "a\nb\nc", b: "b\nc\nd" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      counts: { onlyA: 1, onlyB: 1, shared: 2 },
      onlyA: ["a"],
      onlyB: ["d"],
    });
  });

  it("diffs two JSON documents by path", () => {
    const result = compareDataTool({
      mode: "json",
      a: '{"port":8080,"name":"x"}',
      b: '{"port":"8080","name":"x"}',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ stats: { typeChanged: 1 } });
  });

  it("rejects a side that is not valid JSON, naming which one", () => {
    const result = compareDataTool({ mode: "json", a: "{oops", b: "{}" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/left/);
  });

  it("reports env differences by key WITHOUT reproducing the secret", () => {
    const secretA = "postgres://user:supersecret@localhost:5432/db";
    const secretB = "postgres://user:othersecret@prod.internal:5432/db";
    const result = compareDataTool({
      mode: "env",
      a: `DATABASE_URL=${secretA}\nPORT=3000`,
      b: `DATABASE_URL=${secretB}\nPORT=3000`,
    });
    expect(result.ok).toBe(true);
    const payload = JSON.stringify(result.data);
    expect(payload).not.toContain("supersecret");
    expect(payload).not.toContain("othersecret");
    expect(payload).toContain("DATABASE_URL");
    expect(result.data).toMatchObject({ stats: { mismatch: 1, matched: 1 } });
  });

  it("refuses an unknown mode and explains the three that exist", () => {
    const result = compareDataTool({ mode: "binary", a: "1", b: "2" });
    expect(result.ok).toBe(false);
    for (const mode of ["list", "json", "env"]) {
      expect(String((result.data as { error: string }).error)).toContain(mode);
    }
  });
});

describe("diff_text", () => {
  it("produces a unified patch with additions and deletions", () => {
    const result = diffTextTool({ original: "a\nb\nc", modified: "a\nB\nc" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ additions: 1, deletions: 1 });
    const patch = (result.data as { patch: string }).patch;
    expect(patch).toContain("-b");
    expect(patch).toContain("+B");
  });

  it("says plainly when the two sides are identical", () => {
    const result = diffTextTool({ original: "same", modified: "same" });
    expect(result.data).toMatchObject({ unchanged: true, additions: 0, deletions: 0 });
    expect(String((result.data as { note?: string }).note)).toMatch(/identical/);
  });

  it("detects the language when none is given, and honours one when it is", () => {
    const auto = diffTextTool({
      original: "def f():\n    return 1",
      modified: "def f():\n    return 2",
    });
    expect((auto.data as { language: string }).language).toBe("python");

    const explicit = diffTextTool({ original: "x", modified: "y", language: "yaml" });
    expect((explicit.data as { language: string }).language).toBe("yaml");
    expect(explicit.data).not.toHaveProperty("languageConfidence");
  });

  it("caps the patch and says it did", () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const changed = Array.from({ length: 400 }, (_, i) => `changed ${i}`).join("\n");
    const result = diffTextTool({ original: big, modified: changed, maxPatchChars: 600 });
    const patch = (result.data as { patch: string }).patch;
    expect(patch.length).toBeLessThan(800);
    expect(patch).toContain("truncated");
  });

  it("treats an empty side as an addition or a deletion, not a modification", () => {
    expect(diffTextTool({ original: "", modified: "new" }).data).toMatchObject({ status: "added" });
    expect(diffTextTool({ original: "old", modified: "" }).data).toMatchObject({ status: "deleted" });
  });
});

describe("search_library", () => {
  it("lists what the reference covers when called with no arguments", () => {
    const result = searchLibraryTool({});
    expect(result.ok).toBe(true);
    const apis = (result.data as { apis: { name: string }[] }).apis;
    expect(apis.length).toBeGreaterThan(10);
    expect(apis.map((a) => a.name)).toContain("GlideRecord");
  });

  it("finds a method by name and returns its real signature", () => {
    const result = searchLibraryTool({ query: "addQuery" });
    expect(result.ok).toBe(true);
    const matches = (result.data as { matches: { api: string; method?: string; signature?: string }[] })
      .matches;
    expect(matches.length).toBeGreaterThan(0);
    // Several APIs legitimately have addQuery, so the assertion is that the
    // one the caller is most likely reaching for is IN the results with its
    // signature — not that it wins a tie-break.
    const record = matches.find((m) => m.api === "GlideRecord" && m.method === "addQuery");
    expect(record).toBeDefined();
    expect(record!.signature).toMatch(/addQuery\(/);
  });

  it("reads one API in full when given a name", () => {
    const result = searchLibraryTool({ api: "GlideRecord" });
    expect(result.ok).toBe(true);
    const methods = (result.data as { methods: { name: string; example: string }[] }).methods;
    expect(methods.length).toBeGreaterThan(1);
    expect(methods.every((m) => typeof m.example === "string")).toBe(true);
  });

  it("names near misses when an api does not exist", () => {
    const result = searchLibraryTool({ api: "GlideRecrd" });
    expect(result.ok).toBe(false);
    expect(String((result.data as { error: string }).error)).toMatch(/GlideRecord|Closest names/);
  });

  it("returns an honest empty result plus a next step for a miss", () => {
    const result = searchLibraryTool({ query: "zzzzqqqq" });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ matches: [] });
    expect(String((result.data as { note: string }).note)).toMatch(/ServiceNow server\/client APIs only/);
  });

  it("always marks the reference as data, never instructions", () => {
    const result = searchLibraryTool({ query: "getValue" });
    expect(String((result.data as { note: string }).note)).toMatch(/never instructions/);
  });
});
