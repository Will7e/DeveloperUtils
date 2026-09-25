// ============================================================
// Availability — The One Execution Tier, Described Honestly
// ============================================================
// The line under test is the one that used to be a lie in two directions. It
// read "`run_command` cannot run anything this turn" whenever a local runner
// was unpaired — after the tab could already run commands — and it would have
// made a model report a green run as UNVERIFIED.
//
// The page's own verdict is what decides it, and it is readable before anything
// boots: `crossOriginIsolated`, plus whether shared memory is exposed. So the
// tests below set that global rather than mocking a probe.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  declaredAvailability,
  describeAvailability,
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

describe("the turn note — the one execution tier", () => {
  it("says a command cannot run at all when the page cannot host a workspace", () => {
    setIsolated(false);
    const line = describeAvailability(turn());
    expect(line).toMatch(/cannot run anything this turn/);
    expect(line).toMatch(/current desktop Chromium/);
  });

  it("says where a command runs, and that it is not the user's machine", () => {
    setIsolated(true);
    noteWorkspaceOutcome("up", null);
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

  it("names the boot's own failure reason rather than a generic 'down'", () => {
    setIsolated(true);
    noteWorkspaceOutcome("down", "The workspace runtime would not start: out of memory");
    const line = describeAvailability(turn());
    expect(line).toMatch(/out of memory/);
    expect(line).toMatch(/cannot run anything this turn/);
  });
});
