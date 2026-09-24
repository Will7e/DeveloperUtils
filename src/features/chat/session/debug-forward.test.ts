// ============================================================
// Debug Forward — Diagnostics On The Failure, Not On Request
// ============================================================
// The rules this guards are the ones that keep the console usable:
// only failure phases forward, a burst reads as one report, and a
// page that unmounts stops reporting.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COALESCE_MS,
  forwardDiagnostics,
  installDebugForward,
  resetDebugForward,
  shouldAutoForward,
} from "./debug-forward";
import { logTurnEvent, resetTurnLog } from "./turn-log";

describe("shouldAutoForward", () => {
  it("forwards the phases where a turn lost something", () => {
    for (const phase of [
      "error",
      "model-failure",
      "failover",
      "abort",
      "orphan-abort",
    ] as const) {
      expect(shouldAutoForward(phase), phase).toBe(true);
    }
  });

  it("stays quiet for the phases of a turn that worked", () => {
    for (const phase of [
      "turn-start",
      "model-attempt",
      "stream-end",
      "tool-phase",
      "completion-gate",
      "resume",
    ] as const) {
      expect(shouldAutoForward(phase), phase).toBe(false);
    }
  });
});

/**
 * Silences the group the report prints into and hands back its spies.
 * Every case here asserts on the SPY, so the real report never needs to
 * reach the test runner's stdout.
 */
function captureReport() {
  return {
    group: vi.spyOn(console, "groupCollapsed").mockImplementation(() => {}),
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    end: vi.spyOn(console, "groupEnd").mockImplementation(() => {}),
  };
}

describe("installDebugForward", () => {
  beforeEach(() => {
    resetDebugForward();
    resetTurnLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the report when a failure phase is recorded", () => {
    const { group, log, end } = captureReport();

    const uninstall = installDebugForward();
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "error", detail: "boom" });
    uninstall();

    expect(group).toHaveBeenCalledTimes(1);
    const headline = String(group.mock.calls[0]![0]);
    expect(headline).toContain("error");
    expect(headline).toContain("boom");
    // The log dump and the scorecard ride inside the group.
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a phase that is not a failure", () => {
    const { group } = captureReport();

    const uninstall = installDebugForward();
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "tool-phase" });
    uninstall();

    expect(group).not.toHaveBeenCalled();
  });

  it("coalesces a burst into one report", () => {
    const { group } = captureReport();

    const uninstall = installDebugForward();
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "error" });
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "failover" });
    uninstall();

    expect(group).toHaveBeenCalledTimes(1);
  });

  it("reports again once the coalescing window has passed", () => {
    const { group } = captureReport();

    const uninstall = installDebugForward();
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "error" });
    // Move past the window rather than waiting on the clock.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + COALESCE_MS + 1);
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "abort" });
    uninstall();

    expect(group).toHaveBeenCalledTimes(2);
  });

  it("stops reporting after unsubscribe", () => {
    const { group } = captureReport();

    const uninstall = installDebugForward();
    uninstall();
    logTurnEvent({ turnId: "t", conversationId: "c", phase: "error" });

    expect(group).not.toHaveBeenCalled();
  });
});

describe("forwardDiagnostics", () => {
  beforeEach(() => {
    resetTurnLog();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the phase, the detail and the model in the headline", () => {
    const { group } = captureReport();

    forwardDiagnostics({
      at: 0,
      turnId: "t",
      conversationId: "c",
      phase: "model-failure",
      detail: "429",
      modelId: "openai/gpt-4o-mini",
    });

    const headline = String(group.mock.calls[0]![0]);
    expect(headline).toContain("model-failure");
    expect(headline).toContain("429");
    expect(headline).toContain("openai/gpt-4o-mini");
  });
});
