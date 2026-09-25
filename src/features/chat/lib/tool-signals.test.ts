// ============================================================
// Tool Signals — Rules, Caps, Dedupe, Surface Filtering
// ============================================================
// The unit-test style the sibling (skill-signals.test.ts) uses: pure
// inputs, no stores, each rule tested to fire on its fact and stay
// silent without it.

import { describe, it, expect } from "vitest";
import { renderToolSignalBlock, selectToolSignals, TOOL_SIGNAL_MAX } from "./tool-signals";

/** The full surface: every rule can name every tool */
const FULL_SURFACE = [
  "run_checks",
  "read_ci_logs",
  "read_preview",
  "preview_snapshot",
  "preview_evaluate",
  "read_file",
  "get_workspace_diff",
  "search_web",
  "fetch_url",
  "write_file",
  "diff_text",
];

const quiet: Omit<import("./tool-signals").ToolSignalInput, "surface"> = {
  failingChecks: [],
  changedPaths: [],
  previewErrors: [],
  userText: "",
};

describe("selectToolSignals", () => {
  it("stays silent when nothing is happening", () => {
    const signals = selectToolSignals({ ...quiet, surface: FULL_SURFACE });
    expect(signals).toEqual([]);
    expect(renderToolSignalBlock(signals)).toBe("");
  });

  it("fires the failing-check rule on a failing check", () => {
    const signals = selectToolSignals({
      ...quiet,
      failingChecks: ["`npm test` exited 1 — 3 failed"],
      surface: FULL_SURFACE,
    });
    expect(signals.map((s) => s.id)).toEqual(["failing-check"]);
    expect(signals[0]!.tools).toContain("run_checks");
  });

  it("stays silent on the same input without the failing check", () => {
    const signals = selectToolSignals({
      ...quiet,
      failingChecks: [],
      surface: FULL_SURFACE,
    });
    expect(signals.find((s) => s.id === "failing-check")).toBeUndefined();
  });

  it("fires the preview-error rule on fresh preview errors", () => {
    const signals = selectToolSignals({
      ...quiet,
      previewErrors: ["TypeError: x is not a function"],
      surface: FULL_SURFACE,
    });
    expect(signals.map((s) => s.id)).toEqual(["preview-error"]);
  });

  it("fires the changed-data rule only for data-shaped changed paths", () => {
    const code = selectToolSignals({
      ...quiet,
      changedPaths: ["src/App.tsx", "src/lib/x.ts"],
      surface: FULL_SURFACE,
    });
    expect(code.find((s) => s.id === "changed-data-files")).toBeUndefined();

    const data = selectToolSignals({
      ...quiet,
      changedPaths: ["config/settings.yaml", "src/data/users.json"],
      surface: FULL_SURFACE,
    });
    expect(data.find((s) => s.id === "changed-data-files")).toBeDefined();
  });

  it("fires the web rule only when the user names a URL AND a lookup intent", () => {
    const urlOnly = selectToolSignals({
      ...quiet,
      userText: "the URL is https://example.com",
      surface: FULL_SURFACE,
    });
    expect(urlOnly.find((s) => s.id === "web-request")).toBeUndefined();

    const both = selectToolSignals({
      ...quiet,
      userText: "check https://developer.mozilla.org/docs/Web/API/fetch for the docs",
      surface: FULL_SURFACE,
    });
    expect(both.find((s) => s.id === "web-request")).toBeDefined();
  });

  it("fires the report rule on a written-deliverable request", () => {
    const signals = selectToolSignals({
      ...quiet,
      userText: "give me a report of the failing tests",
      surface: FULL_SURFACE,
    });
    expect(signals.map((s) => s.id)).toContain("report-request");
  });

  it("drops a note whose tools the surface does not carry (advertised-but-withheld)", () => {
    const signals = selectToolSignals({
      ...quiet,
      failingChecks: ["`npm test` exited 1"],
      // No verify-side tools offered at all
      surface: ["read_file", "write_file"],
    });
    expect(signals).toEqual([]);
  });

  it("keeps only the offered subset of a note's tools", () => {
    const signals = selectToolSignals({
      ...quiet,
      previewErrors: ["Uncaught ReferenceError: foo"],
      surface: ["read_preview"],
    });
    const note = signals.find((s) => s.id === "preview-error");
    expect(note).toBeDefined();
    expect(note!.tools).toEqual(["read_preview"]);
  });

  it("caps the number of notes per round", () => {
    const signals = selectToolSignals({
      failingChecks: ["a check failed"],
      changedPaths: ["data/results.json"],
      previewErrors: ["boom"],
      userText: "summarize the findings in a report",
      surface: FULL_SURFACE,
    });
    expect(signals.length).toBeLessThanOrEqual(TOOL_SIGNAL_MAX);
    // And the cap is the exported constant, not a coincidence
    expect(TOOL_SIGNAL_MAX).toBeGreaterThan(0);
  });

  it("dedupes against prior rounds' notes", () => {
    const input = {
      failingChecks: ["`npm test` exited 1"],
      changedPaths: [] as string[],
      previewErrors: [] as string[],
      userText: "",
      surface: FULL_SURFACE,
    };
    const first = selectToolSignals(input);
    expect(first.map((s) => s.id)).toContain("failing-check");

    const second = selectToolSignals({ ...input, priorNotes: first.map((s) => s.id) });
    expect(second.find((s) => s.id === "failing-check")).toBeUndefined();
  });

  it("fires the repeated-failure rule after 2+ distinct failing tools and 3+ runs of one", () => {
    const under = selectToolSignals({
      ...quiet,
      failedToolCalls: 2,
      mostFailedTool: "http_request",
      failedToolExecutions: 3,
      surface: ["read_skill", "http_request"],
    });
    const note = under.find((s) => s.id === "repeated-tool-failure");
    expect(note).toBeDefined();
    expect(note!.note).toContain("http_request");
    expect(note!.note).toContain("3 times");
  });

  it("stays silent below the friction threshold and without read_skill", () => {
    const oneFailure = selectToolSignals({
      ...quiet,
      failedToolCalls: 1,
      mostFailedTool: "http_request",
      failedToolExecutions: 3,
      surface: ["read_skill"],
    });
    expect(oneFailure.find((s) => s.id === "repeated-tool-failure")).toBeUndefined();

    const noSurface = selectToolSignals({
      ...quiet,
      failedToolCalls: 3,
      mostFailedTool: "http_request",
      failedToolExecutions: 4,
      surface: ["http_request"], // read_skill withheld → nothing to point at
    });
    expect(noSurface.find((s) => s.id === "repeated-tool-failure")).toBeUndefined();
  });

  it("is deterministic across calls with identical input", () => {
    const input = {
      failingChecks: ["check failed"],
      changedPaths: ["data/x.json"],
      previewErrors: [],
      userText: "",
      surface: FULL_SURFACE,
    };
    const a = selectToolSignals(input);
    const b = selectToolSignals(input);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });
});

describe("renderToolSignalBlock", () => {
  it("renders each note as one bullet under a one-line header", () => {
    const block = renderToolSignalBlock([
      { id: "failing-check", tools: ["run_checks"], note: "A check is failing." },
      { id: "preview-error", tools: ["read_preview"], note: "The preview threw." },
    ]);
    const lines = block.split("\n");
    expect(lines[0]).toMatch(/situation this turn is in/);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("renders empty for no signals", () => {
    expect(renderToolSignalBlock([])).toBe("");
  });
});
