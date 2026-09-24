// ============================================================
// Change Set Verification — tests
// ============================================================
// The rules worth pinning are the ones that could quietly become a lie: a fresh
// failure marks its files, a stale one marks nothing, and a project-wide
// diagnostic is never mistaken for a filename.

import { describe, expect, it } from "vitest";
import { failingPaths, hasFreshPass } from "./change-set-verification";
import type { VerificationEvidence, VerificationKind, VerificationStatus } from "./verification-ledger";

function entry(
  status: VerificationStatus,
  details: string[] = [],
  kind: VerificationKind = "typecheck"
): VerificationEvidence {
  return {
    kind,
    status,
    at: 0,
    workspaceUpdatedAt: 1,
    ageMs: 0,
    ok: status === "fresh-pass",
    summary: `${kind} ${status}`,
    details,
  };
}

describe("failingPaths", () => {
  it("names the files a fresh failure reports", () => {
    const paths = failingPaths([
      entry("fresh-fail", ["src/api/client.ts:41 TS2322: Type 'string' is not assignable to 'number'"]),
    ]);
    expect([...paths]).toEqual(["src/api/client.ts"]);
  });

  it("ignores stale failures — they describe bytes that are no longer here", () => {
    const paths = failingPaths([
      entry("stale", ["src/api/client.ts:41 TS2322: boom"], "typecheck"),
    ]);
    expect(paths.size).toBe(0);
  });

  it("never treats a project-wide diagnostic as a file", () => {
    const paths = failingPaths([
      entry("fresh-fail", [
        "(project) TS18003: No inputs were found in config file",
        "src/app.ts:12 TS1234: real error",
      ]),
    ]);
    expect([...paths]).toEqual(["src/app.ts"]);
  });

  it("tolerates a missing line number or code without crashing", () => {
    const paths = failingPaths([
      entry("fresh-fail", ["src/plain.ts: something went wrong", "src/bare.ts", "", "   "]),
    ]);
    // `src/bare.ts` carries no colon at all and is skipped rather than guessed
    // at; a path that cannot be parsed is not a path this pane may point at.
    expect([...paths]).toEqual(["src/plain.ts"]);
  });

  it("collects across several failing kinds and de-duplicates", () => {
    const paths = failingPaths([
      entry("fresh-fail", ["src/a.ts:1 TS1: x"], "typecheck"),
      entry("fresh-fail", ["src/a.ts:1 TS1: x", "src/b.ts:2 TS2: y"], "command"),
    ]);
    expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports nothing when there is no evidence", () => {
    expect(failingPaths([]).size).toBe(0);
  });
});

describe("hasFreshPass", () => {
  it("is true only for a pass against the current revision", () => {
    expect(hasFreshPass([entry("fresh-pass")])).toBe(true);
    expect(hasFreshPass([entry("stale")])).toBe(false);
    expect(hasFreshPass([entry("fresh-fail", [], "typecheck")])).toBe(false);
    expect(hasFreshPass([])).toBe(false);
  });
});
