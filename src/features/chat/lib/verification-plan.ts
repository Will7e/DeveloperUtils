// ============================================================
// Verification Plan — Which Tier Can Actually Prove This Change
// ============================================================
// The harness has three ways to turn "this should work" into "this passed", and
// they are not interchangeable:
//
//   typecheck  runs in the browser over the workspace's own sources. Always
//              available, and always the weakest: it answers "does this
//              type-check", never "does this work".
//   workspace  runs the project's OWN commands — install, test, build — in a
//              browser workspace in this tab. No pairing, no push, no server:
//              the real dependency graph executes. Weaker than the user's own
//              machine in a way that is worth stating rather than hiding (it is
//              the tab's Linux-ish runtime, so no native toolchains, no
//              services), and stronger than a type check by a long way.
//   ci         dispatches the repository's own workflow on the pushed branch.
//              Authoritative for the pull request, the only tier that can
//              verify Python/Rust/Docker/service-backed projects, and the
//              slowest — it needs the branch pushed first.
//
// The gap this module closes is not a missing capability, it is a missing
// DECISION. Every tier was a tool the model had to pick from prose, and the
// prose was wrong in one direction: a model would describe running the tests,
// or call `run_checks` (which proves nothing by itself) and report the result
// as if it were a pass. Two failure modes came out of that, and both are
// expensive: a confident "verified" over an unverified change, and a turn
// spent discovering by failure what was knowable in advance.
//
// So the facts are collected ONCE, per turn, and turned into an ordered list of
// what could run, what it would prove, and what is stopping it. Pure and
// clock-free so the matrix is unit-testable rather than observed in a
// transcript — the same discipline as ci-plan.ts.
//
// Deliberately NOT a router that runs things: it answers "what should I reach
// for", and the model still makes the call. What it removes is the guesswork.

import type { CapabilityState } from "./availability";
import type { VerificationEvidence, VerificationKind } from "./verification-ledger";

/** Strongest last in the label order, and first in a recommendation. */
export type VerificationTier = VerificationKind;

/** The tool that produces each tier */
export type VerificationTool = "run_checks" | "run_command" | "verify_with_ci";

export interface VerificationStep {
  tier: VerificationTier;
  tool: VerificationTool;
  /** What this tier proves, in one line, in the words the model should use */
  proves: string;
  /** True when it can run right now, with the push state as given */
  available: boolean;
  /** Why it cannot run, when it cannot — stated so the model can say it */
  blockedBy?: string;
  /** True when a run is the only thing missing (a push, a page) */
  needs?: "push" | "repository" | "workspace";
}

export interface VerificationPlanInput {
  /** A repository (and token) are attached, so there is a project to verify */
  repoAttached: boolean;
  /** A change set exists in the workspace */
  hasChanges: boolean;
  /**
   * Whether this page can host a browser workspace, and whether one is up.
   *
   * Optional so every existing caller keeps its meaning: an unobserved
   * workspace is reported as available-but-unprobed rather than as absent, and
   * "unsupported" (no cross-origin isolation) is the honest "down".
   */
  workspace?: CapabilityState;
  /**
   * The change set has been pushed to its working branch, which is what makes
   * CI dispatchable. False for the ordinary mid-task case.
   */
  pushed: boolean;
  /**
   * The project declares runnable checks (a package.json with a test/build
   * script, a Makefile, AGENTS.md naming them). Changes only the WORDING of
   * what `command` would prove — an undeclared project can still be verified
   * by asking for a specific command.
   */
  declaresChecks?: boolean;
  /** What has already been proven, for the "already done" line */
  evidence?: readonly VerificationEvidence[];
}

export interface VerificationPlan {
  /** Every tier, strongest first, each stating what it would prove */
  steps: VerificationStep[];
  /** The tier to reach for now, or null when nothing can run */
  recommended: VerificationStep | null;
  /** Tiers that could run but are already satisfied by fresh evidence */
  alreadyProven: VerificationTier[];
  /**
   * The block for the turn note, or "" when there is nothing to say. The only
   * silent case is a turn with no repository: there is no project to verify and
   * nothing the reader could do about it.
   */
  summary: string;
}

const TIER_PROVES: Record<VerificationTier, string> = {
  ci: "the repository's own workflow on the pushed branch — the authoritative definition of green for the pull request",
  workspace:
    "the project's real commands in a browser workspace in this tab (install, build, test) — the actual dependency graph runs, but not your own environment: no native toolchains and no services",
  typecheck: "that the workspace's own sources type-check — nothing about whether the change behaves correctly",
};

/**
 * `run_command` serves two tiers, deliberately.
 *
 * Which workspace a command runs in is a routing decision the harness makes
 * Which workspace a command runs in is a routing decision the harness makes
 * from facts the model cannot see (is this page cross-origin isolated? has a
 * runtime booted?), and asking a model to choose between two spellings of
 * "run npm test" is how it picks the one that cannot run.
 */
const TIER_TOOL: Record<VerificationTier, VerificationTool> = {
  ci: "verify_with_ci",
  workspace: "run_command",
  typecheck: "run_checks",
};

/** Strongest first: CI beats a tab beats a static check. */
const TIER_ORDER: readonly VerificationTier[] = ["ci", "workspace", "typecheck"];

/**
 * Builds the turn's verification plan.
 *
 * `now` is deliberately absent: nothing here ages evidence. Freshness is
 * already derived by the ledger against the workspace revision, and a second
 * notion of recency in this module would be a second answer to the same
 * question.
 */
export function planVerification(input: VerificationPlanInput): VerificationPlan {
  const evidence = input.evidence ?? [];
  const workspace = input.workspace ?? "unknown";
  const freshPass = new Set(
    evidence.filter((e) => e.status === "fresh-pass").map((e) => e.kind)
  );

  const steps: VerificationStep[] = TIER_ORDER.map((tier) => {
    const base = { tier, tool: TIER_TOOL[tier], proves: TIER_PROVES[tier] } as VerificationStep;

    if (tier === "typecheck") {
      if (!input.repoAttached) {
        return {
          ...base,
          available: false,
          needs: "repository",
          blockedBy: "no repository is attached, so there are no project sources to check",
        };
      }
      return { ...base, available: true };
    }

    if (tier === "workspace") {
      if (!input.repoAttached) {
        return {
          ...base,
          available: false,
          needs: "repository",
          blockedBy: "no repository is attached, so there is no project to run",
        };
      }
      if (workspace === "down") {
        return {
          ...base,
          available: false,
          needs: "workspace",
          blockedBy:
            "this page cannot host a browser workspace (it is not cross-origin isolated), so no command can run in the tab",
        };
      }
      // "unknown" is NOT "up". Whether a page can host a workspace is declared
      // (it is `crossOriginIsolated`, readable before anything boots), so an
      // unobserved state means the caller did not say — and a tier promised on a
      // guess is how a model reports a command it never ran. It is named as
      // unchecked instead, which is true and actionable.
      if (workspace !== "up") {
        return {
          ...base,
          available: false,
          needs: "workspace",
          blockedBy: "whether this page can host a browser workspace has not been checked yet",
        };
      }
      return {
        ...base,
        available: true,
        proves: input.declaresChecks
          ? base.proves
          : `${base.proves} — this project does not declare its checks, so name the command and say what it proved`,
      };
    }

    // ci
    if (!input.repoAttached) {
      return {
        ...base,
        available: false,
        needs: "repository",
        blockedBy: "no repository is attached, so there is no workflow to dispatch",
      };
    }
    if (!input.pushed) {
      return {
        ...base,
        available: false,
        needs: "push",
        blockedBy:
          "the change set has not been pushed to its working branch, and CI runs on a pushed branch — push first (through the approval gate), or verify locally",
      };
    }
    return { ...base, available: true };
  });

  // A tier that already ran against THIS revision is settled, pass or fail: the
  // ledger stamps the workspace revision, so a fresh failure is a fact about the
  // current bytes and re-running it unchanged reproduces the same answer. Both
  // are therefore skipped for the recommendation — and the moment the agent
  // edits the code the revision moves, the evidence goes stale, and the tier
  // becomes recommendable again. That is the whole point of stamping it.
  const settled = new Set<VerificationEvidence["kind"]>(
    evidence.filter((e) => e.status !== "stale").map((e) => e.kind)
  );
  const freshFailures = evidence.filter((e) => e.status === "fresh-fail");

  const recommended =
    steps.find((s) => s.available && !settled.has(s.tier)) ?? null;

  const alreadyProven = steps
    .filter((s) => freshPass.has(s.tier))
    .map((s) => s.tier);

  return {
    steps,
    recommended,
    alreadyProven,
    summary: describePlan({ steps, recommended, alreadyProven, freshFailures, input }),
  };
}

/**
 * The sentence for the turn note and the header chip.
 *
 * It states the plan only when stating it changes what the reader does. A turn
 * where the strongest tier is available and nothing has been proven yet gets a
 * line, because that is exactly the turn that ships an unverified change. A
 * turn where the change is already proven at the strongest available tier gets
 * nothing, because "carry on" is not information.
 */
function describePlan(params: {
  steps: VerificationStep[];
  recommended: VerificationStep | null;
  alreadyProven: VerificationTier[];
  freshFailures: VerificationEvidence[];
  input: VerificationPlanInput;
}): string {
  const { steps, recommended, alreadyProven, freshFailures, input } = params;
  if (!input.repoAttached) return "";

  const lines: string[] = [`# Verification`, ``];

  // A fresh failure leads, unconditionally: it is the only line here that
  // changes what the reader should do next. Buried under a tier summary it
  // reads as context and the turn reports progress on code that is failing.
  if (freshFailures.length > 0) {
    lines.push(
      `A check already ran against this EXACT revision and FAILED:`,
      ...freshFailures.map(
        (f) =>
          `- ${f.kind}: ${f.summary}${
            (f.details ?? []).length > 0 ? ` — first failures: ${(f.details ?? []).slice(0, 3).join(" | ")}` : ""
          }`
      ),
      `Fix the cause and re-run the SAME command. Do not report this change as working, and do not describe the failure as a limitation of the environment.`,
      ``
    );
  }

  if (recommended === null) {
    const anyAvailable = steps.some((s) => s.available);
    if (anyAvailable) {
      // Everything reachable is already settled against this revision. Saying
      // "nothing can prove this" here would be false and would send the model
      // looking for a tier it already used.
      lines.push(
        `Every tier you can reach has already run against this exact revision${
          alreadyProven.length > 0 ? ` (passed: ${alreadyProven.join(", ")})` : ""
        }. Do not re-run them; they describe this code. Make the change, then re-verify.`
      );
      return lines.join("\n");
    }
    const reasons = steps
      .map((s) => s.blockedBy)
      .filter((b): b is string => typeof b === "string");
    if (reasons.length === 0) return "";
    lines.push(
      `Nothing can prove a change this turn: ${dedupe(reasons).join("; ")}. Say so plainly instead of describing what the checks would do.`
    );
    return lines.join("\n");
  }

  lines.push(
    `Strongest tier you can reach: \`${recommended.tool}\` — it proves ${recommended.proves}.`
  );
  if (recommended.blockedBy) {
    // An AVAILABLE step can still carry a caveat (the workspace waiting on its
    // boot). Stated here because the "not available" list below only covers the
    // tiers this turn cannot reach at all.
    lines.push(`Before you rely on it: ${recommended.blockedBy}.`);
  }
  if (alreadyProven.length > 0) {
    lines.push(
      `Already proven against this exact revision: ${alreadyProven.join(", ")}. Do not re-run those; they describe this code.`
    );
  }
  const blocked = steps
    .filter((s) => !s.available && s.blockedBy)
    .map((s) => `- \`${s.tool}\` (${s.tier}): ${s.blockedBy}`);
  if (blocked.length > 0) {
    lines.push(``, `Not available this turn:`, ...blocked);
  }
  lines.push(
    ``,
    `A change nothing ran against is UNVERIFIED. Do not report it as working, and do not upgrade a type check into "the tests pass".`
  );
  return lines.join("\n");
}

/** Keeps the summary short when two tiers fail for the same reason */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// ============================================================
// The four states, derived once
// ============================================================
// Two surfaces now answer the same question — the header chip and the Changes
// pane that shows the diff being reviewed — and the answer is dangerous to
// duplicate. A pane that said "verified" while the chip said "stale" would
// teach the reader to trust neither, so the derivation lives here, beside the
// tier matrix, and both surfaces import it.

/** What the reader needs to know, in one word */
export type VerificationState =
  /** A check FAILED against the current revision — the only unambiguously bad state */
  | "fail"
  /** Something passed against the current revision */
  | "pass"
  /** Something ran, then the code changed: the result describes older bytes */
  | "stale"
  /** Nothing has run against this revision at all */
  | "none";

/**
 * Which state to show.
 *
 * Failures outrank successes on purpose. A turn that ran the tests, broke them,
 * then fixed and re-ran the type check has a fresh pass AND a stale failure; the
 * safe reading is the failure, because a user who sees a green tick stops
 * reading. `stale` outranks `none` for the same reason in reverse: a result that
 * describes older code is not the same as no result, and collapsing the two
 * would hide the one that needs re-running.
 */
export function verificationState(
  evidence: readonly VerificationEvidence[]
): VerificationState {
  if (evidence.some((e) => e.status === "fresh-fail")) return "fail";
  if (evidence.some((e) => e.status === "fresh-pass")) return "pass";
  if (evidence.length > 0) return "stale";
  return "none";
}

/** The word for each state, spelled once so both surfaces say the same thing */
export const VERIFICATION_STATE_LABEL: Record<VerificationState, string> = {
  fail: "Checks failed",
  pass: "Verified",
  stale: "Stale",
  none: "Unverified",
};

/**
 * Tier names for a badge.
 *
 * Short on purpose: the full `VERIFICATION_KIND_LABEL` sentences belong in the
 * card, because the chip's job is to name WHICH tier proved it — the distinction
 * a transcript cannot show, since a passing type check and a passing test suite
 * read identically there and prove completely different things.
 */
export const VERIFICATION_TIER_SHORT: Record<VerificationTier, string> = {
  typecheck: "types",
  workspace: "browser",
  ci: "CI",
};

/**
 * The strongest passing tier, or undefined when nothing passed.
 *
 * "Strongest" is the tier order above (ci > browser > typecheck), not the order
 * results arrived: a browser run after a green CI dispatch is weaker evidence,
 * and labelling the chip with it would understate what is known.
 */
export function strongestPass(
  evidence: readonly VerificationEvidence[]
): VerificationEvidence | undefined {
  return TIER_ORDER.map((tier) =>
    evidence.find((e) => e.kind === tier && e.status === "fresh-pass")
  ).find((e): e is VerificationEvidence => e !== undefined);
}

/**
 * The entry a badge is speaking about, so the age it shows belongs to the claim
 * it makes.
 *
 * A failing check is the entry worth dating ("FAILED 2 min ago"), then the
 * strongest pass, then the most recent stale run — "stale" is the one state
 * where the NEWEST result is the relevant one, because it is the run that has to
 * be repeated.
 */
export function representativeEvidence(
  evidence: readonly VerificationEvidence[]
): VerificationEvidence | undefined {
  const failure = evidence.find((e) => e.status === "fresh-fail");
  if (failure) return failure;
  const pass = strongestPass(evidence);
  if (pass) return pass;
  return [...evidence].sort((a, b) => b.at - a.at)[0];
}

/**
 * The full label for a badge: "Verified · command" when something passed, the
 * state word otherwise. Takes evidence rather than a state so a caller cannot
 * pair a pass state with a tier that did not pass.
 */
export function verificationLabel(evidence: readonly VerificationEvidence[]): string {
  const state = verificationState(evidence);
  if (state !== "pass") return VERIFICATION_STATE_LABEL[state];
  const strongest = strongestPass(evidence);
  return strongest
    ? `${VERIFICATION_STATE_LABEL.pass} · ${VERIFICATION_TIER_SHORT[strongest.kind]}`
    : VERIFICATION_STATE_LABEL.pass;
}
