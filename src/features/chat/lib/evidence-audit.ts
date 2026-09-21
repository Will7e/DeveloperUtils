// ============================================================
// Evidence Audit — Does the Agent's Story Match the Diff?
// ============================================================
// There is no shell in this workspace. The agent can edit files and it
// can verify a web app through the preview, but it CANNOT run a test
// suite, a linter, or a type-checker. A model that does not internalise
// that will happily write "all tests pass" — and a reviewer, reading a
// confident summary above a large diff, will believe it.
//
// This module is the cheap, honest counterweight: it compares what the
// final message CLAIMS against what actually happened in the turn
// (the changed paths, the tools that ran, whether anything was verified
// in the preview) and reports the gaps to the human at the approval
// gate.
//
// Deliberately conservative. A false accusation ("you claimed a file you
// never touched") destroys trust in the gate faster than a missed one,
// so paths are only flagged when they appear on a line that makes a
// change claim, and verification claims are only flagged when no
// verification tool ran at all.

import type { PushWarning } from "../types";

/** The standing truth every agent prompt carries about verification */
export const VERIFICATION_LIMIT_NOTE =
  "This workspace has no shell: you cannot run test suites, linters, type-checkers, or build scripts. " +
  "Never imply such a check passed. Say explicitly which checks you did NOT run — an honest gap is " +
  "worth far more than a claim the reviewer will discover is false.";

/** Tools that constitute real verification inside this workspace */
export const VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  "get_preview_feedback",
  "run_in_preview",
  "query_preview_dom",
]);

export type EvidenceCode = "unbacked-file-claim" | "unverified-claim";

export interface EvidenceFinding {
  code: EvidenceCode;
  /** Reviewer-facing explanation */
  message: string;
  /** The exact claims that could not be backed */
  evidence: string[];
}

export interface EvidenceAuditInput {
  /** The agent's final message (what it asserts) */
  claim: string;
  /** Paths actually changed in the workspace */
  changedPaths: string[];
  /** Tool names that ran during this turn */
  toolsUsed?: string[];
}

/** Verbs that turn a sentence into a change claim */
const CHANGE_VERB =
  /\b(?:add|added|adds|change|changed|changes|update|updated|updates|modify|modified|modifies|create|created|creates|fix|fixed|fixes|delete|deleted|deletes|remove|removed|removes|rename|renamed|renames|refactor|refactored|refactors|implement|implemented|implements|introduce|introduced|introduces|migrate|migrated|migrates|replace|replaced|replaces|edit|edited|edits|write|wrote|written)\b/i;

/**
 * Claims that are IMPOSSIBLE to substantiate in this workspace: there is
 * no shell, so nothing here can run a test suite, a type-checker or a
 * linter. Flagged unconditionally — no tool could have made them true.
 */
const IMPOSSIBLE_CLAIM =
  /\b(?:all\s+tests?\s+(?:pass(?:e[sd])?|are\s+green|succeed|succeeded)|tests?\s+(?:pass(?:e[sd])?|are\s+green|succeed|succeeded|green)|test\s+suite\s+(?:pass(?:e[sd])?|is\s+green)|type[- ]?check(?:s|ed|ing)?\s+(?:pass(?:e[sd])?|clean|succeeds?(?:ed)?)|lints?\s+(?:clean|passed)|(?:ran|ran\s+the|executed)\s+(?:the\s+)?tests?|(?:jest|vitest|pytest|mocha|cypress)\s+(?:pass(?:e[sd])?|green))\b/i;

/**
 * Claims the PREVIEW can substantiate (it really does build and run the
 * app) — flagged only when no verification tool ran in the turn, which
 * means the model is describing an expected outcome as an observed one.
 */
const UNVERIFIED_CLAIM =
  /\b(?:build\s+(?:pass(?:e[sd])?|succeeds?(?:ed)?|is\s+green|clean)|compiles?\s+(?:cleanly|successfully|without)|i\s+verified|i\s+checked|confirmed\s+working|manually\s+tested|verified\s+(?:working|that\s+it\s+works))\b/i;

/** A path-looking token: has a separator, or a known source extension */
const PATH_TOKEN =
  /(?:[\w.@-]+\/)+[\w.@-]+(?:\.[A-Za-z0-9]{1,6})?|\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|kts|cs|php|swift|c|cc|cpp|h|hpp|css|scss|sass|less|html|vue|svelte|json|ya?ml|toml|ini|env|md|mdx|sql|sh|bash|zsh|tf|lock)\b/gi;

/** Normalizes a path for comparison (no leading ./ or /) */
function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * True when a claimed path is present in the change set, allowing for
 * the partial paths models write (`App.tsx` for `src/App.tsx`).
 */
function isCovered(claimed: string, changedPaths: string[]): boolean {
  const needle = normalizePath(claimed).toLowerCase();
  if (!needle) return true;
  return changedPaths.some((raw) => {
    const path = normalizePath(raw).toLowerCase();
    return path === needle || path.endsWith(`/${needle}`) || needle.endsWith(`/${path}`);
  });
}

/** Paths named on a line that makes a change claim */
export function extractClaimedPaths(claim: string): string[] {
  const out = new Set<string>();
  for (const line of claim.split("\n")) {
    if (!CHANGE_VERB.test(line)) continue;
    const tokens = line.match(PATH_TOKEN) ?? [];
    for (const token of tokens) {
      // Skip bare extensions and URLs
      if (token.length < 4) continue;
      if (/^https?:\/\//i.test(token)) continue;
      if (!token.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(token)) continue;
      // Trailing prose punctuation ("…/format.ts.", "…/a.ts:") is not
      // part of the path and must not make an honest claim look false.
      out.add(normalizePath(token).replace(/[.,;:]+$/, ""));
    }
  }
  return [...out];
}

/** True when the turn actually verified something observable */
export function ranVerification(toolsUsed: string[] | undefined): boolean {
  if (!toolsUsed?.length) return false;
  return toolsUsed.some((t) => VERIFICATION_TOOLS.has(t));
}

/**
 * Audits one final message. Returns findings only — formatting and where
 * they surface (approval gate, transcript, turn log) is the caller's job.
 */
export function auditClaims(input: EvidenceAuditInput): EvidenceFinding[] {
  const findings: EvidenceFinding[] = [];
  const claim = input.claim ?? "";
  const changed = input.changedPaths ?? [];
  if (!claim.trim()) return findings;

  // ── 1. Files claimed as changed but absent from the change set ──
  const unbacked: string[] = [];
  for (const path of extractClaimedPaths(claim)) {
    if (changed.length === 0) break; // nothing was changed: a different conversation
    if (!isCovered(path, changed)) unbacked.push(path);
  }
  if (unbacked.length > 0) {
    findings.push({
      code: "unbacked-file-claim",
      message:
        `${unbacked.length} file(s) are described as changed but are not in this change set: ` +
        `${unbacked.slice(0, 6).join(", ")}${unbacked.length > 6 ? ", …" : ""}. ` +
        "Either the edit never happened, or it was reverted.",
      evidence: unbacked,
    });
  }

  // ── 2. Checks that are impossible in this workspace ──
  const impossible = IMPOSSIBLE_CLAIM.exec(claim);
  if (impossible) {
    findings.push({
      code: "unverified-claim",
      message:
        `The summary claims a check that cannot run here ("${impossible[0]}"). ` +
        "This workspace has no shell: test suites, type-checkers and linters are not available. " +
        "Treat that part of the summary as unverified.",
      evidence: [impossible[0]],
    });
  }

  // ── 3. Preview-verifiable claims with nothing verifying them ──
  const expected = UNVERIFIED_CLAIM.exec(claim);
  if (expected && !ranVerification(input.toolsUsed)) {
    findings.push({
      code: "unverified-claim",
      message:
        `The summary asserts an outcome nothing checked ("${expected[0]}"). ` +
        "No preview build, DOM query or in-preview run happened in this turn, so this is an " +
        "expectation rather than an observation.",
      evidence: [expected[0]],
    });
  }

  return findings;
}

/** Converts findings into approval-gate warnings */
export function evidenceWarnings(findings: EvidenceFinding[]): PushWarning[] {
  return findings.map((f) => ({ kind: "evidence" as const, message: f.message }));
}

/** One-line summary for the tool result the model sees */
export function evidenceSummary(findings: EvidenceFinding[]): string {
  if (findings.length === 0) return "Every claim in the summary is backed by the change set.";
  return findings.map((f) => f.message).join(" ");
}
