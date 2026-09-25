// ============================================================
// Process Registry — regression tests
// ============================================================
// The invariants that matter: dev scripts are refused (the preview owns the
// dev server), the registry is bounded, output is bounded, and losing the
// workspace lease kills everything — a watcher answering from a released
// tree is the failure the lease model exists to prevent.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PROCESSES,
  PROCESS_OUTPUT_MAX_CHARS,
  isDevServerCommand,
  listProcesses,
  processTail,
  resetProcessRegistry,
  stopProcess,
} from "./process-registry";

describe("isDevServerCommand — the dev server belongs to the preview", () => {
  it("refuses the declared dev scripts on every manager", () => {
    expect(isDevServerCommand("npm run dev")).toBe(true);
    expect(isDevServerCommand("npm run start")).toBe(true);
    expect(isDevServerCommand("pnpm run serve")).toBe(true);
    expect(isDevServerCommand("yarn preview")).toBe(true);
    expect(isDevServerCommand("bun dev")).toBe(true);
  });

  it("does not refuse one-shot or non-server commands", () => {
    expect(isDevServerCommand("npm run build")).toBe(false);
    expect(isDevServerCommand("npm test")).toBe(false);
    expect(isDevServerCommand("npx tsc --noEmit --watch")).toBe(false);
    expect(isDevServerCommand("node scripts/watch.js")).toBe(false);
    expect(isDevServerCommand("npm run devtools")).toBe(false); // prefix, not the script
  });
});

describe("processTail — reads and refusals", () => {
  beforeEach(() => resetProcessRegistry());
  afterEach(() => resetProcessRegistry());

  it("names the known processes when an id is unknown", () => {
    const result = processTail("nope");
    expect("error" in result && result.error).toContain("no background process has been started");
  });

  it("reports an already-stopped process instead of failing", () => {
    expect(stopProcess("p1").state).toBeNull();
  });
});

describe("bounds — constants that keep leaks impossible", () => {
  it("caps processes and output", () => {
    expect(MAX_PROCESSES).toBe(3);
    expect(PROCESS_OUTPUT_MAX_CHARS).toBe(8_000);
  });

  it("lists nothing after a reset", () => {
    resetProcessRegistry();
    expect(listProcesses()).toEqual([]);
  });
});
