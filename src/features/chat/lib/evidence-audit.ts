// ============================================================
// Evidence Audit — Does the Agent's Story Match the Diff?
// ============================================================
// A summary is prose until it is checked against what actually happened. The
// agent can edit files, run the project's own commands on the user's machine
// (`run_command`) and dispatch the repository's CI (`verify_with_ci`) — and a
// model that does not
// internalise which of those it did will happily write "all tests pass"
// after none of them ran. A reviewer, reading a confident summary above a
// large diff, will believe it.
//
// This module is the cheap, honest counterweight: it compares what the
// final message CLAIMS against what actually happened in the turn — the
// changed paths, the tools that ran, and the evidence the verification
// ledger holds — and reports the gaps to the human at the approval gate.
//
// It is evidence-based, not assumption-based, and that distinction was a
// real bug: this file used to flag every "all tests pass" as impossible
// because the workspace genuinely had no shell. Once one existed, the same
// rule fired on honest, passing test runs. An audit that cries wolf about
// good evidence trains the reviewer to ignore it, so the rule now asks
// whether anything backs the claim.
//
// Deliberately conservative. A false accusation ("you claimed a file you
// never touched") destroys trust in the gate faster than a missed one,
// so paths are only flagged when they appear on a line that makes a
// change claim, and verification claims are only flagged when no
// verification tool ran at all.

import type { PushWarning } from "../types";

/** The standing truth every agent prompt carries about verification */
/**
 * The standing verification note, injected into every turn.
 *
 * It used to read "This workspace has no shell: you cannot run test suites,
 * linters, type-checkers, or build scripts" — true when written, and by the
 * time it was false it had become the single most expensive line in the
 * product: injected on every turn, it told the agent that the execution
 * tiers did not exist, so it never reached for them.
 *
 * What survives is the half that is always true — do not imply a check you
 * did not run — plus the tiers that can now actually run one.
 */
export const VERIFICATION_LIMIT_NOTE =
  "Prove it, or say so. `run_command` runs the project's real commands (install, build, test, lint, " +
  "typecheck) in a working tree on the user's machine, and `verify_with_ci` dispatches the repository's own " +
  "GitHub Actions workflow on the pushed branch — use them before claiming a change works. A non-zero exit " +
  "code IS a failure, and a CI run that skipped, did not finish, or did not pass is not a pass. " +
  "If neither tier is available, say explicitly which checks you did NOT run: an honest gap is worth far " +
  "more than a claim the reviewer will discover is false. Evidence also goes stale — if you edited files " +
  "after a run, that result describes older code.";

/** Tools that constitute real verification inside this workspace */
export const VERIFICATION_TOOLS: ReadonlySet<string> = new Set([
  // Real execution. `run_command` runs the project's own commands in a
  // working tree on the user's machine; `verify_with_ci` runs the
  // repository's own workflow. Both produce the evidence a claim needs, so
  // a claim they substantiate is not an unsupported one.
  "run_command",
  "verify_with_ci",
]);

export type EvidenceCode =
  | "unbacked-file-claim"
  | "unverified-claim"
  /** Real verification ran and its result contradicts the summary */
  | "contradicted-claim";

export interface EvidenceFinding {
  code: EvidenceCode;
  /** Reviewer-facing explanation */
  message: string;
  /** The exact claims that could not be backed */
  evidence: string[];
}

/**
 * A verification result as the ledger reports it. The audit needs two
 * bits: did it run, and did it pass — plus whether it still describes the
 * code being pushed, because a stale pass supports nothing.
 */
export interface VerificationFact {
  status: "fresh-pass" | "fresh-fail" | "stale";
  summary: string;
  details?: string[];
}

export interface EvidenceAuditInput {
  /** The agent's final message (what it asserts) */
  claim: string;
  /** Paths actually changed in the workspace */
  changedPaths: string[];
  /** Tool names that ran during this turn */
  toolsUsed?: string[];
  /** The in-browser type check, when it ran against this revision */
  typecheck?: VerificationFact | null;
  /** A command run through the local companion, when one ran */
  command?: VerificationFact | null;
  /** The repository's own CI, when a run was watched to a conclusion */
  ci?: VerificationFact | null;
}

/** Verbs that assert an outcome, used to spot a contradicted summary */
const OUTCOME_ASSERTION =
  /\b(?:works?|working|works\s+now|functions?|functional|pass(?:es|ed)?|passing|succeeds?|succeeded|verified|fixed|no\s+(?:longer\s+)?(?:issue|problem|error)s?|all\s+good|done|complete[d]?|correct(?:ly)?)\b/i;

/** Verbs that turn a sentence into a change claim */
const CHANGE_VERB =
  /\b(?:add|added|adds|change|changed|changes|update|updated|updates|modify|modified|modifies|create|created|creates|fix|fixed|fixes|delete|deleted|deletes|remove|removed|removes|rename|renamed|renames|refactor|refactored|refactors|implement|implemented|implements|introduce|introduced|introduces|migrate|migrated|migrates|replace|replaced|replaces|edit|edited|edits|write|wrote|written)\b/i;

/**
 * Claims that a command-line check RAN and passed.
 *
 * This used to be flagged unconditionally, and correctly so: there was no
 * shell, so "all tests pass" was impossible to substantiate and saying so
 * was always right. There IS a shell now — `run_command` on the user's own
 * machine, and `verify_with_ci` for the repository's workflow — so the
 * unconditional rule became a false alarm on a genuinely passing test run.
 * An audit that cries wolf about good evidence teaches the reviewer to
 * ignore it, which costs more than the finding was ever worth.
 *
 * The rule is therefore evidence-based: the claim is unsupported when
 * nothing backs it, and silent when something does.
 */
const EXECUTED_CHECK_CLAIM =
  /\b(?:all\s+tests?\s+(?:pass(?:e[sd])?|are\s+green|succeed|succeeded)|tests?\s+(?:pass(?:e[sd])?|are\s+green|succeed|succeeded|green)|test\s+suite\s+(?:pass(?:e[sd])?|is\s+green)|type[- ]?check(?:s|ed|ing)?\s+(?:pass(?:e[sd])?|clean|succeeds?(?:ed)?)|lints?\s+(?:clean|passed)|(?:ran|ran\s+the|executed)\s+(?:the\s+)?tests?|(?:jest|vitest|pytest|mocha|cypress)\s+(?:pass(?:e[sd])?|green))\b/i;

/**
 * Claims that only real execution can substantiate (a build that ran, a
 * change that was checked) — flagged when no verification tool ran in the
 * turn, which means the model is describing an expected outcome as an
 * observed one.
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

  // ── 2. A check the summary says ran, with nothing that ran it ──
  const executed = EXECUTED_CHECK_CLAIM.exec(claim);
  const command = input.command ?? null;
  const ci = input.ci ?? null;
  const executionEvidence = [command, ci].filter((fact): fact is VerificationFact => fact !== null);
  if (executed && executionEvidence.length === 0) {
    findings.push({
      code: "unverified-claim",
      message:
        `The summary claims a command-line check ran ("${executed[0]}") and nothing in this turn shows for it. ` +
        "A test suite, type check or linter is not something this workspace can conclude on its own: run it with " +
        "`run_command` (in a real working tree, on the user's machine), or verify the pushed branch with " +
        "`verify_with_ci`. Until one of those runs, treat that part of the summary as unverified.",
      evidence: [executed[0]],
    });
  }

  // ── 3. Claims with nothing verifying them ──
  const expected = UNVERIFIED_CLAIM.exec(claim);
  if (expected && !ranVerification(input.toolsUsed)) {
    findings.push({
      code: "unverified-claim",
      message:
        `The summary asserts an outcome nothing checked ("${expected[0]}"). ` +
        "No command run or CI check happened in this turn, so this is an " +
        "expectation rather than an observation.",
      evidence: [expected[0]],
    });
  }

  // ── 4. Verification that ran and says the opposite ──
  // The only case where a summary is contradicted by hard evidence rather
  // than merely unsupported. Failing results are quoted verbatim: the model
  // cannot argue with its own output, and the reviewer needs the detail.
  const typecheck = input.typecheck ?? null;
  const failing: { source: string; fact: VerificationFact }[] = [];
  if (typecheck?.status === "fresh-fail") {
    failing.push({ source: "The in-browser type check", fact: typecheck });
  }
  // A real command or CI run failing is the strongest contradiction there
  // is: it is the project's own definition of green, and it said no.
  if (command?.status === "fresh-fail") {
    failing.push({ source: "A command run in the working tree", fact: command });
  }
  if (ci?.status === "fresh-fail") {
    failing.push({ source: "The repository's CI", fact: ci });
  }
  if (failing.length > 0 && OUTCOME_ASSERTION.test(claim)) {
    const worst = failing[0]!;
    const shown = (worst.fact.details ?? []).slice(0, 3);
    findings.push({
      code: "contradicted-claim",
      message:
        `${worst.source} ran against this exact workspace revision and FAILED (${worst.fact.summary}), ` +
        `while the summary describes the change as working.` +
        (failing.length > 1
          ? ` ${failing.length - 1} other result(s) also failed: ${failing.slice(1).map((f) => `${f.source} — ${f.fact.summary}`).join("; ")}.`
          : "") +
        (shown.length > 0 ? ` First failures — ${shown.join(" | ")}` : ""),
      evidence: shown.length > 0 ? shown : [worst.fact.summary],
    });
  }

  // ── 5. A pass that no longer describes this code ──
  // "Tests passed" is true but useless once the files have changed. The
  // distinction matters because it is exactly the sentence a model writes
  // after fixing something without re-running anything.
  const stale: { source: string; summary: string }[] = [];
  if (typecheck?.status === "stale") {
    stale.push({ source: "the in-browser type check", summary: typecheck.summary });
  }
  // The commonest version of this: the tests DID pass, and then three more
  // edits happened. "Tests pass" is then true and worthless.
  if (command?.status === "stale") stale.push({ source: "a command run", summary: command.summary });
  if (ci?.status === "stale") stale.push({ source: "the repository's CI", summary: ci.summary });
  if (stale.length > 0 && OUTCOME_ASSERTION.test(claim)) {
    const worst = stale[0]!;
    findings.push({
      code: "unverified-claim",
      message:
        `The summary leans on ${worst.source}, which ran before the last edit to the workspace — it describes older code, ` +
        "not this diff. Re-run it, or say plainly that the current revision was not verified." +
        (stale.length > 1 ? ` (Also stale: ${stale.slice(1).map((s) => s.source).join(", ")}.)` : ""),
      evidence: [worst.summary].filter(Boolean),
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
