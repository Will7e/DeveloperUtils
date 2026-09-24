// ============================================================
// Run Plan Tests — The Install Is A Claim, And So Is Each Check
// ============================================================
// These tests are mostly about honesty in one of two directions: a command whose
// claim is narrower than it sounds (a type check proves types, not behaviour),
// and a command that must not be offered at all (anything that keeps running).

import { describe, it, expect } from "vitest";
import {
  CONTAINER_MAX_OUTPUT_CHARS,
  MAX_PLANNED_CHECKS,
  capOutput,
  describeRunPlan,
  normalizePackageManager,
  planInstall,
  planRun,
  stepsOf,
} from "./run-plan";

const PKG = JSON.stringify({
  name: "demo",
  scripts: { test: "vitest run", build: "vite build", dev: "vite", lint: "eslint ." },
});

describe("import manager normalization — a pinned manager is still that manager", () => {
  it("strips a version, keeps a scope", () => {
    expect(normalizePackageManager("pnpm@9.15.0")).toBe("pnpm");
    expect(normalizePackageManager("yarn@4.1.1")).toBe("yarn");
    expect(normalizePackageManager("PNPM")).toBe("pnpm");
    expect(normalizePackageManager("pnpm")).toBe("pnpm");
    expect(normalizePackageManager("@yarnpkg/cli@4.1.1")).toBe("@yarnpkg/cli");
    expect(normalizePackageManager("  ")).toBeNull();
    expect(normalizePackageManager(null)).toBeNull();
  });

  it("installs through the manager the manifest pins, not through npm", () => {
    // The form corepack requires is the PINNED one, so a comparison against
    // "pnpm" alone missed every manifest that follows the recommendation — and
    // the result was `npm install` in a pnpm repository, under a note claiming
    // the lockfile's versions were installed.
    const pnpm = planInstall({
      packageManager: "pnpm@9.15.0",
      lockfiles: ["pnpm-lock.yaml"],
      hasPackageJson: true,
    });
    expect(pnpm.step?.command).toBe("pnpm install --frozen-lockfile");

    const yarn = planInstall({
      packageManager: "yarn@4.1.1",
      lockfiles: [],
      hasPackageJson: true,
    });
    expect(yarn.step?.command).toBe("yarn install");
    expect(yarn.note).toMatch(/resolves now/);

    const bun = planInstall({
      packageManager: "bun@1.1.0",
      lockfiles: ["bun.lockb"],
      hasPackageJson: true,
    });
    expect(bun.step?.command).toBe("bun install --frozen-lockfile");
  });
});

describe("planInstall — the tree the repository declares, or a note saying otherwise", () => {
  it("uses npm ci when the lockfile is there, because it refuses to silently repair", () => {
    const { step, note } = planInstall({ lockfiles: ["package-lock.json"], hasPackageJson: true });
    expect(step?.command).toBe("npm ci --no-audit --no-fund");
    expect(step?.proves).toContain("lockfile");
    expect(note).toBeNull();
  });

  it("falls back to install and SAYS the versions are not the declared ones", () => {
    const { step, note } = planInstall({ lockfiles: [], hasPackageJson: true });
    expect(step?.command).toBe("npm install --no-audit --no-fund");
    expect(note).toContain("whatever resolves now");
  });

  it("honours the repository's own package manager", () => {
    expect(planInstall({ packageManager: "pnpm@9", lockfiles: ["pnpm-lock.yaml"], hasPackageJson: true }).step?.command).toBe(
      "pnpm install --frozen-lockfile"
    );
    expect(planInstall({ packageManager: "yarn@4", lockfiles: ["yarn.lock"], hasPackageJson: true }).step?.command).toBe(
      "yarn install --immutable"
    );
    expect(planInstall({ packageManager: "bun@1", lockfiles: ["bun.lockb"], hasPackageJson: true }).step?.command).toBe(
      "bun install --frozen-lockfile"
    );
  });

  it("proposes no install at all when there is no package.json", () => {
    const { step, note } = planInstall({ lockfiles: [], hasPackageJson: false });
    expect(step).toBeNull();
    expect(note).toContain("nothing to install");
  });
});

describe("planRun — what the repository declares, minus what must not run", () => {
  const plan = planRun({ packageJson: PKG, lockfiles: ["package-lock.json"] });

  it("offers install then the declared checks, in the contract's priority order", () => {
    expect(stepsOf(plan).map((s) => s.command)).toEqual([
      "npm ci --no-audit --no-fund",
      "npm run lint",
      "npm run test",
      "npm run build",
    ]);
  });

  it("never offers a server as a check, and explains what would happen if it did", () => {
    // `dev` never even reaches the plan: by name it is not a verification script.
    expect(plan.checks.map((c) => c.command)).not.toContain("npm run dev");

    // `test:watch` IS one by name and a long-running process in fact — the case
    // the exclusion and its note exist for.
    const watchy = planRun({
      packageJson: JSON.stringify({ scripts: { "test:watch": "vitest", test: "vitest run", dev: "vite" } }),
      lockfiles: [],
    });
    expect(watchy.checks.map((c) => c.command)).toEqual(["npm run test"]);
    expect(watchy.notes.join(" ")).toContain("starts a server");
    expect(watchy.notes.join(" ")).toContain("fight it for the port");
  });

  it("states the claim each check licenses, and keeps it narrow", () => {
    const test = plan.checks.find((c) => c.command === "npm run test");
    const build = plan.checks.find((c) => c.command === "npm run build");
    const lint = plan.checks.find((c) => c.command === "npm run lint");
    expect(test?.proves).toContain("test suite passes");
    expect(build?.proves).toContain("it compiles");
    expect(lint?.proves).toContain("not correctness");
  });

  it("warns that the command runs in the user's tab and is killed at a timeout", () => {
    expect(plan.notes.join(" ")).toContain("browser tab");
    expect(plan.notes.join(" ")).toContain("killed at its timeout");
  });

  it("lets an explicit manifest outrank package.json scripts", () => {
    const withManifest = planRun({
      packageJson: PKG,
      verifyManifest: JSON.stringify({ checks: ["npm run verify:all"] }),
      lockfiles: ["package-lock.json"],
    });
    expect(withManifest.checks[0]?.command).toBe("npm run verify:all");
    expect(withManifest.checks[0]?.source).toBe("manifest");
  });

  it("caps the list and hands back the rest rather than forgetting it", () => {
    const scripts = Object.fromEntries(
      Array.from({ length: MAX_PLANNED_CHECKS + 3 }, (_, i) => [`test:${i}`, "vitest run"])
    );
    const capped = planRun({ packageJson: JSON.stringify({ scripts }), lockfiles: [] });
    expect(capped.checks).toHaveLength(MAX_PLANNED_CHECKS);
    expect(capped.notes.join(" ")).toContain("the first 6 are offered");
    expect(capped.notes.join(" ")).toContain("test:6");
  });

  it("says so plainly when a revision declares nothing to run", () => {
    const nothing = planRun({ packageJson: JSON.stringify({ name: "empty" }), lockfiles: [] });
    expect(nothing.checks).toEqual([]);
    expect(describeRunPlan(nothing)).toEqual([
      "- Install (npm): `npm install --no-audit --no-fund` — dependencies resolve today, not as a lockfile declares",
    ]);
    const bare = planRun({});
    expect(describeRunPlan(bare)).toEqual(["- This revision declares nothing to run."]);
  });

  it("keeps an end-to-end suite's claim honest about services it cannot reach", () => {
    const e2e = planRun({
      packageJson: JSON.stringify({ scripts: { e2e: "playwright test" } }),
      lockfiles: [],
    });
    expect(e2e.checks[0]?.proves).toContain("no network services the project depends on");
  });
});

describe("capOutput — elided, and said out loud", () => {
  it("passes short output through untouched, with no note", () => {
    const capped = capOutput("ok\n");
    expect(capped.truncated).toBe(false);
    expect(capped.note).toBeNull();
    expect(capped.text).toBe("ok\n");
  });

  it("keeps the head and tail of long output and counts what it dropped", () => {
    const long = `${"a".repeat(30_000)}THE-END`;
    const capped = capOutput(long, CONTAINER_MAX_OUTPUT_CHARS);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toContain("characters elided");
    expect(capped.text.endsWith("THE-END")).toBe(true);
    expect(capped.note).toContain(`${long.length - CONTAINER_MAX_OUTPUT_CHARS} of ${long.length}`);
    expect(capped.note).toContain("Do not read a pass");
  });
});
