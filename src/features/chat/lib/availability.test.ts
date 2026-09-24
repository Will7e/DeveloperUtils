// ============================================================
// Availability — The Two Execution Tiers, Described Together
// ============================================================
// The line under test is the one that used to be a lie. It read "`run_command`
// cannot run anything this turn" whenever the companion was down — which stopped
// being true the moment this app could run a command in its own tab, and which
// would have made a model report a green run as UNVERIFIED.
//
// The page's own verdict is what decides it, and it is readable before anything
// boots: `crossOriginIsolated`, plus whether shared memory is exposed. So the
// tests below set that global rather than mocking a probe.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  declaredAvailability,
  describeAvailability,
  noteCompanionOutcome,
  noteWorkspaceOutcome,
  resetAvailability,
  workspaceSupport,
} from "./availability";

const globals = globalThis as Record<string, unknown>;
const originalIsolated = globals.crossOriginIsolated;

function setIsolated(value: boolean): void {
  globals.crossOriginIsolated = value;
}

function turn(): Parameters<typeof describeAvailability>[0] {
  return declaredAvailability({ repo: null, mcpServers: 0, model: undefined });
}

beforeEach(() => resetAvailability());
afterEach(() => {
  globals.crossOriginIsolated = originalIsolated;
  resetAvailability();
});

describe("workspaceSupport — declared from the page, proven by a boot", () => {
  it("is down on a page that is not cross-origin isolated, and says what would fix it", () => {
    setIsolated(false);
    const support = workspaceSupport();
    expect(support.state).toBe("down");
    expect(support.reason).toMatch(/cross-origin isolated/);
  });

  it("is not 'up' merely because the page could host one", () => {
    setIsolated(true);
    expect(workspaceSupport().state).toBe("unknown");
    noteWorkspaceOutcome("up", null);
    expect(workspaceSupport().state).toBe("up");
  });

  it("carries the boot's own failure reason rather than a generic 'down'", () => {
    setIsolated(true);
    noteWorkspaceOutcome("down", "The workspace runtime would not start: out of memory");
    expect(workspaceSupport().reason).toBe("The workspace runtime would not start: out of memory");
  });
});

describe("the turn note — one question, two tiers", () => {
  it("says a command cannot run at all only when NEITHER tier can", () => {
    setIsolated(false);
    noteCompanionOutcome("down", "no companion is paired with this app");
    const line = describeAvailability(turn());
    expect(line).toMatch(/cannot run anything this turn/);
    expect(line).toMatch(/current desktop Chromium/);
    expect(line).toMatch(/pair a companion/);
  });

  it("offers the tab instead — and says where the command ran", () => {
    setIsolated(true);
    noteWorkspaceOutcome("up", null);
    noteCompanionOutcome("down", "no companion is paired with this app");
    const line = describeAvailability(turn());
    expect(line).toMatch(/browser workspace running in this tab/);
    // The consequence that matters: a green result from a WASM runtime is not a
    // green result from the user's machine, and the model has to say which.
    expect(line).toMatch(/runs in the browser workspace, not on the user's machine/);
    expect(line).not.toMatch(/cannot run anything this turn/);
  });

  it("offers it before anything has booted, without claiming it already runs", () => {
    setIsolated(true);
    const line = describeAvailability(turn());
    expect(line).toMatch(/available on this page \(not started yet\)/);
  });

  it("stays quiet about the workspace when the page cannot host one and a companion is paired", () => {
    setIsolated(false);
    noteCompanionOutcome("up");
    const line = describeAvailability(turn());
    expect(line).toMatch(/local companion running/);
    expect(line).not.toMatch(/cannot run anything this turn/);
  });
});
