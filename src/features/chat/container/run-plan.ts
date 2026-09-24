// ============================================================
// Run Plan — What To Run In A Container, And What It Would Prove
// ============================================================
// Two decisions live here, and both are cheap to get wrong in ways that read as
// success:
//
//   1. WHAT to install. A container starts empty, so nothing runs before an
//      install — and the difference between `npm ci` and `npm install` is the
//      difference between the versions the lockfile pins and whatever resolved
//      today. A verification claim about the latter is a claim about a tree the
//      repository never declared.
//
//   2. WHAT to run. The repository already declares its checks (`.intab/verify.json`,
//      `package.json` scripts, an AGENTS.md section), and lib/verify-contract.ts
//      already knows how to read all three. This module reuses that reading and
//      adds the one rule a container needs: a SERVER is not a check. `npm run dev`
//      belongs to the harness that owns the preview; proposing it here would put
//      the model in a race with the harness over the same port, which is the
//      classic way a workspace hangs forever.
//
// Pure: strings in, a plan out. Nothing here touches a container.
// ============================================================

import { elide } from "../lib/web-page";
import {
  checksFromAgentsMd,
  checksFromPackageJson,
  parseVerifyManifest,
  type CheckSource,
  type DeclaredCheck,
} from "../lib/verify-contract";

/** Output kept for the model — the same order of magnitude as the local runner */
export const CONTAINER_MAX_OUTPUT_CHARS = 20_000;

/**
 * A command is killed at this point.
 *
 * Shorter than the local runner's default on purpose: this runs in the user's
 * tab, where a five-minute `npm ci` is already a visible cost to them (battery,
 * memory, a tab they cannot close). A timeout is REPORTED as a timeout, never as
 * a failure of the code under test.
 */
export const CONTAINER_DEFAULT_TIMEOUT_MS = 240_000;
export const CONTAINER_MAX_TIMEOUT_MS = 600_000;

/** Steps proposed at once. Beyond this the plan is a wall of commands, not a plan */
export const MAX_PLANNED_CHECKS = 6;

/**
 * Script names that start a server rather than prove something.
 *
 * Suffix-matched, not prefix-matched, because the interesting cases are the
 * qualified ones: `test:watch` and `e2e:serve` are verification scripts by name
 * and long-running processes in fact.
 */
const SERVER_SCRIPT = /(^|:)(dev|start|serve|preview|watch)$/i;

export interface PlannedStep {
  id: string;
  label: string;
  command: string;
  /** What a zero exit would license the agent to claim */
  proves: string;
  source: CheckSource;
}

export interface RunPlan {
  /** The install step, or null when the revision declares no dependencies */
  install: PlannedStep | null;
  checks: PlannedStep[];
  /** Facts the caller must state rather than assume */
  notes: string[];
}

/**
 * The install command for a repository, from its declared manager and its
 * lockfile.
 *
 * A lockfile present means the frozen form is available, and the frozen form is
 * the only one that verifies the tree the repository actually declares. With no
 * lockfile there is nothing to be faithful to, so the plain install is honest —
 * and the note says so, because "installed from a floating resolution" changes
 * what a later green means.
 */
export function planInstall(input: {
  packageManager?: string | null;
  /** Paths present in the mounted tree, e.g. ["package-lock.json"] */
  lockfiles: readonly string[];
  hasPackageJson: boolean;
}): { step: PlannedStep | null; note: string | null } {
  if (!input.hasPackageJson) {
    return { step: null, note: "No package.json in this revision, so there is nothing to install." };
  }
  const has = (name: string) => input.lockfiles.includes(name);
  const manager = normalizePackageManager(input.packageManager) ?? "npm";

  if (manager === "pnpm" || has("pnpm-lock.yaml")) {
    return has("pnpm-lock.yaml")
      ? { step: step("install", "Install (pnpm)", "pnpm install --frozen-lockfile", "the lockfile's exact dependency versions are installed"), note: null }
      : { step: step("install", "Install (pnpm)", "pnpm install --no-frozen-lockfile", "dependencies resolve today, not as the lockfile declares"), note: "No pnpm lockfile in this revision — dependency versions are whatever resolves now." };
  }
  if (manager === "yarn" || has("yarn.lock")) {
    return has("yarn.lock")
      ? { step: step("install", "Install (yarn)", "yarn install --immutable", "the lockfile's exact dependency versions are installed"), note: null }
      : { step: step("install", "Install (yarn)", "yarn install", "dependencies resolve today, not as the lockfile declares"), note: "No yarn.lock in this revision — dependency versions are whatever resolves now." };
  }
  if (manager === "bun" || has("bun.lockb")) {
    return has("bun.lockb")
      ? { step: step("install", "Install (bun)", "bun install --frozen-lockfile", "the lockfile's exact dependency versions are installed"), note: null }
      : { step: step("install", "Install (bun)", "bun install", "dependencies resolve today, not as the lockfile declares"), note: "No bun lockfile in this revision — dependency versions are whatever resolves now." };
  }
  if (has("package-lock.json")) {
    // `ci` over `install`: it refuses when the lockfile and package.json
    // disagree, which is information, where `install` silently repairs it.
    return { step: step("install", "Install (npm ci)", "npm ci --no-audit --no-fund", "the lockfile's exact dependency versions are installed"), note: null };
  }
  return {
    step: step("install", "Install (npm)", "npm install --no-audit --no-fund", "dependencies resolve today, not as a lockfile declares"),
    note: "No package-lock.json in this revision — dependency versions are whatever resolves now.",
  };
}

/** The plan for one revision: install first, then the checks it declares */
export function planRun(input: {
  packageJson?: string | null;
  verifyManifest?: string | null;
  agentsMd?: string | null;
  lockfiles?: readonly string[];
  maxChecks?: number;
}): RunPlan {
  const lockfiles = input.lockfiles ?? [];
  const declared = mergeDeclaredChecks(
    parseVerifyManifest(input.verifyManifest).checks,
    checksFromPackageJson(input.packageJson),
    checksFromAgentsMd(input.agentsMd)
  );

  const notes: string[] = [];
  const install = planInstall({
    packageManager: packageManagerOf(input.packageJson),
    lockfiles,
    hasPackageJson: Boolean(input.packageJson && input.packageJson.trim()),
  });
  if (install.note) notes.push(install.note);

  const maxChecks = input.maxChecks ?? MAX_PLANNED_CHECKS;
  const runnable: DeclaredCheck[] = [];
  for (const check of declared) {
    if (isServerCommand(check.command)) {
      notes.push(
        `\`${check.command}\` starts a server rather than proving anything, so it is not offered as a check — the workspace's own dev server is started and stopped by the app, and a second one would fight it for the port.`
      );
      continue;
    }
    runnable.push(check);
  }
  if (runnable.length > maxChecks) {
    notes.push(
      `${runnable.length} checks are declared; the first ${maxChecks} are offered. The rest: ${runnable.slice(maxChecks).map((c) => `\`${c.command}\``).join(", ")}.`
    );
  }

  notes.push(
    `A command that waits for input is killed at its timeout (${Math.round(CONTAINER_DEFAULT_TIMEOUT_MS / 1000)}s), so pass non-interactive flags. This runs in the user's browser tab: it is slower and smaller than their machine.`
  );

  return {
    install: install.step,
    checks: runnable.slice(0, maxChecks).map((check) => ({
      id: check.id,
      label: check.label,
      command: check.command,
      proves: provesFor(check),
      source: check.source,
    })),
    notes,
  };
}

/** The full ordered list of steps a caller may run, install included */
export function stepsOf(plan: RunPlan): PlannedStep[] {
  return plan.install ? [plan.install, ...plan.checks] : [...plan.checks];
}

function step(id: string, label: string, command: string, proves: string): PlannedStep {
  return { id, label, command, proves, source: "package" };
}

/**
 * Dedupe across sources, keeping the order each source declared.
 *
 * Not `mergeChecks`: that one sorts alphabetically within a source, which throws
 * away the importance order `checksFromPackageJson` works to establish (type
 * check, then lint, then test, then build) — and "the first six offered" is only
 * a sensible cap if the list is ordered by what is cheapest and most decisive.
 * The stronger source still wins a command declared twice: a manifest outranks
 * package.json, which outranks an AGENTS.md sample.
 */
function mergeDeclaredChecks(...lists: DeclaredCheck[][]): DeclaredCheck[] {
  const ordered: DeclaredCheck[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const check of list) {
      const key = check.command.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(check);
    }
  }
  return ordered;
}

/**
 * The package manager a manifest declares, without its version.
 *
 * `packageManager` is usually PINNED — `pnpm@9.15.0`, `yarn@4.1.1`, the form
 * corepack requires — so comparing the field against `"pnpm"`/`"yarn"` directly
 * misses every manifest that follows the recommendation. The consequence is not
 * cosmetic: the install falls through to npm, `npm install` runs in a yarn
 * repository, and the workspace ends up holding a dependency tree the project
 * never declared — under a note that says the lockfile's versions were installed.
 * One implementation, shared with the preview bridge's runner choice, so the
 * install and the dev server cannot disagree about which manager this project uses.
 */
export function normalizePackageManager(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // A trailing `@version` is stripped; a leading `@` is a scope, not a version.
  const at = trimmed.lastIndexOf("@");
  const name = (at > 0 ? trimmed.slice(0, at) : trimmed).trim().toLowerCase();
  return name || null;
}

/** The manager a package.json declares, or null when it does not say */
function packageManagerOf(packageJson: string | null | undefined): string | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as { packageManager?: unknown };
    return typeof parsed.packageManager === "string" ? parsed.packageManager : null;
  } catch {
    return null;
  }
}

/** True for a command whose job is to keep running */
function isServerCommand(command: string): boolean {
  const script = /(?:run|yarn|pnpm|bun)\s+([^\s]+)/i.exec(command)?.[1] ?? "";
  if (SERVER_SCRIPT.test(script)) return true;
  // A bare invocation of a known server binary, or a script that names one.
  return /(^|\s)(vite|next dev|astro dev|webpack serve)\b/i.test(command) || /\s--watch\b/.test(command);
}

/**
 * What a passing check would let the agent claim.
 *
 * Named per family rather than per repository, because the claim has to be
 * narrower than "the change works" in every case — a passing type check says
 * nothing about behaviour, and a passing build says nothing about tests.
 */
function provesFor(check: DeclaredCheck): string {
  const text = `${check.label} ${check.command}`.toLowerCase();
  if (/\be2e\b|playwright|cypress|puppeteer/.test(text)) {
    return "the end-to-end flows the suite covers pass in a container with no network services the project depends on";
  }
  if (/\btest\b|vitest|jest|mocha|pytest|ava/.test(text)) {
    return "the project's own test suite passes against this revision, with dependencies installed from the lockfile";
  }
  if (/typecheck|type-check|\btsc\b/.test(text)) {
    return "the project's own type checker reports no errors — types only, not behaviour";
  }
  if (/\blint\b|eslint|biome/.test(text)) {
    return "the linter reports no errors — style and likely-bug rules, not correctness";
  }
  if (/\bbuild\b/.test(text)) {
    return "the project builds with its declared toolchain — it compiles, not that it behaves";
  }
  return `\`${check.command}\` exits zero, which is what the repository declares as verification`;
}

/**
 * Output as the model should see it: head and tail kept, omission counted.
 *
 * Reused from the web-fetch path rather than re-derived, and the note is
 * deliberately blunt: an agent that reads a pass out of elided output has been
 * told, in the same payload, that characters are missing.
 */
export function capOutput(
  text: string,
  maxChars: number = CONTAINER_MAX_OUTPUT_CHARS
): { text: string; truncated: boolean; note: string | null } {
  const kept = elide(text, maxChars);
  if (!kept.truncated) return { text: kept.text, truncated: false, note: null };
  return {
    text: kept.text,
    truncated: true,
    note: `Output was elided: ${text.length - maxChars} of ${text.length} characters are not shown (the head and tail are kept). Do not read a pass out of output you have not seen.`,
  };
}

/** The plan as the lines a model reads before choosing a command */
export function describeRunPlan(plan: RunPlan): string[] {
  const lines: string[] = [];
  if (plan.install) lines.push(`- ${plan.install.label}: \`${plan.install.command}\` — ${plan.install.proves}`);
  for (const check of plan.checks) lines.push(`- ${check.label}: \`${check.command}\` — ${check.proves}`);
  if (plan.install === null && plan.checks.length === 0) {
    lines.push("- This revision declares nothing to run.");
  }
  return lines;
}
