// ============================================================
// Completion Gate — is the work actually done when the model stops?
// ============================================================
// The harness had exactly one definition of "finished": the model
// stopped asking for tools. That is a definition of "stopped", not of
// "done", and it is why a multi-step task ends on the sentence "now
// I'll wire the route" with nothing wired. The model's own words are
// the weakest possible evidence, and we already keep better evidence
// than it does:
//
//   • the plan the agent published (lib/agent-plan.ts), where every
//     step it has not finished is written down in its own words; and
//   • the verification ledger (lib/verification-ledger.ts), which
//     records what actually RAN, and only calls an entry fresh when
//     the revision it describes is still the current one.
//
// So the gate asks a narrow question, and only of those two sources:
//
//   1. PLAN UNFINISHED — the agent left a step open that it never
//      marked done. It made a promise to the user and to itself.
//   2. CHECK FAILING — a real command or CI run FAILED against the code
//      that is in the workspace right now. Not "no check was run";
//      absence of evidence is not a reason to keep working, or every
//      one-line rename would be nagged for a build. A check that ran
//      and said no is a reason, because the agent edited past its own
//      failing proof.
//   3. UNTESTED CHANGE — source changed, a test command RAN GREEN, and no
//      test file changed with it. This is the one rule that reaches past
//      "unfinished" into "not proven", and it is deliberately the narrowest
//      rule here: it needs a passing test command in the evidence, which is
//      only possible in a turn that can actually run this project's tests. A
//      conversation with no companion therefore never sees it, and neither
//      does a documentation-only change — the gate asks for the test it knows
//      the agent was able to write, in the moment it demonstrably could.
//
// Everything else is complete. Gating anything more — a stale pass, a
// missing check, a heuristic read of the closing sentence — would turn
// the gate into a nudge the model learns to ignore, which is worse
// than no gate at all.
//
// Two rules keep this honest rather than nagging:
//
//   * It never overrides a user. An aborted turn, plan mode (where a
//     written plan IS the deliverable) and chat mode are all complete
//     by definition, and the caller passes `aborted` for the same
//     reason a stop button must win.
//   * Its budget is the caller's (`AGENT_COMPLETION_NUDGES`), and the
//     model always has an exit: calling `ask_user` (which parks the turn on
//     a question the user can answer with one click), or clearing its plan,
//     both end the gate's interest. The gate is a checkpoint, not a
//     treadmill.
//
// Pure by design: no stores, no clock, no I/O — the plan, the evidence
// and the stop are all inputs, so every rule here is unit-tested
// without a turn engine.

import type { AgentPlan } from "../types";
import { planProgress } from "./agent-plan";
import { COMPLETION_NUDGE_PREFIX } from "./harness-notices";
import { isNonSourcePath, isTestPath } from "./project-fingerprint";
import { VERIFICATION_KIND_LABEL, type VerificationEvidence } from "./verification-ledger";

/**
 * A test command in a verification summary, in backticks as the ledger writes
 * it: `` `npm test` exited 0 in 2100ms ``. Matched on the COMMAND, not on the
 * word "test" appearing anywhere, because "test" shows up in branch names and
 * file paths often enough to make a loose match fire on the wrong evidence.
 */
const TEST_COMMAND_RE = /`[^`]*(?:\b(?:vitest|jest|pytest|mocha|ava|rspec)\b|\btests?\b|\bspec\b|cargo test|go test)[^`]*`/i;

/** Why the work is not finished, in the order the model sees it. */
export type IncompleteReason =
  | {
      kind: "plan-unfinished";
      /** 1-based position of the first step that is not done */
      stepIndex: number;
      stepCount: number;
      step: string;
    }
  | {
      kind: "check-failing";
      label: string;
      summary: string;
      /** First failure lines, already capped by the producer */
      details: string[];
    }
  | {
      kind: "untested-change";
      /** The source files the change set touches, capped by the producer */
      files: string[];
      /** The (green) test command that proves tests are runnable here */
      run: string;
    }
  | {
      kind: "preview-failing";
      /** First lines of the fresh uncaught exceptions, capped by the producer */
      issues: string[];
    };

export interface CompletionInput {
  /** The agent's published plan for this conversation, when it has one */
  plan?: AgentPlan;
  /**
   * The live preview's status and its issues AT THE STOP, when a preview is
   * running for this conversation. Absent means silent: the gate never asks
   * about an app nobody started. Read at the stop by the caller (same
   * "always the CURRENT revision" rule as `changeSet`), never captured earlier.
   */
  preview?: {
    status: "idle" | "starting" | "running" | "failed" | "stopped";
    /** Epoch ms of the last workspace revision the issues could describe */
    workspaceUpdatedAt: number;
    issues: Array<{ kind: string; message: string; at: number }>;
  };
  /**
   * Evidence for this conversation at the CURRENT workspace revision.
   * Stale entries are ignored here rather than filtered by the caller,
   * so a caller that forgets cannot make a stale pass look current.
   */
  evidence: VerificationEvidence[];
  /**
   * True when the round that just ended actually carried the agent's
   * write tools. Without them there is no work to finish: a prose reply
   * in chat mode, or a plan in plan mode, is the whole answer.
   */
  agentTools: boolean;
  /** True when the user stopped this turn — a stop always wins */
  aborted: boolean;
  /**
   * The change set in the workspace right now, and whether the project has
   * tests at all (a test file exists by convention). Both are absent for a
   * conversation with no workspace — and absent means SILENT: a rule that
   * cannot judge must not guess.
   */
  changeSet?: Array<{ path: string; status: string }>;
  projectHasTests?: boolean;
  /**
   * True when the turn is parked on an `ask_user` question.
   *
   * Waiting is not stopping, and it is emphatically not unfinished work to
   * be nudged about: the model did the thing the nudge asks for (it asked)
   * and the next move belongs to the user. Without this rule a parked turn
   * would be told its work was still open while the answer it needs is on
   * screen, which is how a loop learns to guess instead of asking.
   */
  pendingQuestion?: boolean;
}

export type CompletionVerdict =
  | { complete: true }
  | { complete: false; reasons: IncompleteReason[]; nudge: string; summary: string };

/** One line per reason: the same words in the nudge and in the notice. */
export function describeReason(reason: IncompleteReason): string {
  if (reason.kind === "plan-unfinished") {
    return `your plan step ${reason.stepIndex} of ${reason.stepCount} is still open — "${reason.step}"`;
  }  if (reason.kind === "untested-change") {
    const files = reason.files.slice(0, 4).join(", ");
    return `\`${reason.run}\` is green, but ${reason.files.length} source file(s) changed and no test did (${files || "the change set"})`;
  }
  if (reason.kind === "preview-failing") {
    const first = reason.issues.slice(0, 3).join(" | ");
    return `the RUNNING app threw an unhandled exception (${first}) — the build is green but the page is broken`;
  }
  const failures =
    reason.details.length > 0 ? ` (first failures: ${reason.details.slice(0, 3).join(" | ")})` : "";
  return `${reason.label} ran against the current code and FAILED — ${reason.summary}${failures}`;
}

/**
 * Model-facing continuation instruction. It names the reasons instead of
 * repeating the task, because the model has to act on the gap rather
 * than re-plan the whole job, and it states the two ways out so the
 * loop cannot become a treadmill.
 */
export function completionNudge(reasons: IncompleteReason[]): string {
  return [
    // Shared with the scorecard, which counts these: a metric that matches a
    // sentence the harness no longer writes reports zero forever.
    COMPLETION_NUDGE_PREFIX,
    "",
    "Still outstanding:",
    ...reasons.map((r) => `- ${describeReason(r)}`),
    "",
    "Continue with the next unfinished step. If the remaining work needs a decision only I can make, call `ask_user` with the concrete options and the turn will wait for my answer — do not end the turn on a question in prose, and do not guess. If a recorded failure is expected or outside what I asked for, say so in one line, and clear the plan with `update_plan` (or mark the step done) so the stop is deliberate rather than a leftover.",
    "",
    "If the missing piece is a TEST, write the one that would have caught this: it must fail without your change and pass with it. If a test is genuinely not the right proof here (documentation, config, a rename) or the project has no test covering this area, say that in one line — that is a complete answer, not a refusal.",
  ].join("\n");
}

/** User-facing one-liner for the turn log and the final notice. */
export function completionSummary(reasons: IncompleteReason[]): string {
  return reasons.map(describeReason).join("; ");
}

/**
 * Decides whether a turn that stopped has actually finished.
 *
 * Complete means: the user stopped it, the turn had no write tools, or
 * neither of the two evidence sources above says otherwise.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  if (input.aborted || !input.agentTools || input.pendingQuestion) return { complete: true };

  const reasons: IncompleteReason[] = [];

  // 1. The agent's own checklist. `total > done` is the whole test; a
  //    plan it never published (undefined, or cleared to empty) makes no
  //    claim, and a plan whose steps are all done is a completed promise
  //    even when verification has nothing to say.
  const progress = planProgress(input.plan);
  if (progress.total > 0 && progress.done < progress.total) {
    const open =
      progress.active ?? progress.next ?? input.plan!.steps.find((s) => s.status !== "done")!;
    reasons.push({
      kind: "plan-unfinished",
      stepIndex: input.plan!.steps.findIndex((s) => s.id === open.id) + 1,
      stepCount: progress.total,
      step: open.text,
    });
  }

  // 2. Real evidence that contradicts the current code. `fresh-fail` is
  //    already revision-checked by the ledger, so any entry that reaches
  //    here describes the code in the workspace now.
  for (const entry of input.evidence) {
    if (entry.status !== "fresh-fail") continue;
    reasons.push({
      kind: "check-failing",
      label: VERIFICATION_KIND_LABEL[entry.kind],
      summary: entry.summary,
      details: entry.details ?? [],
    });
  }

  // 2b. The running app's own verdict. Narrow on purpose — see the rule
  //     comment below — and revision-checked here, so an exception from
  //     before the latest edit can never gate a turn that replaced that code.
  const previewReason = previewFailingReason(input);
  if (previewReason) reasons.push(previewReason);

  // 3. Source changed, the suite is green, and nothing tests the change.
  const untested = untestedChangeReason(input);
  if (untested) reasons.push(untested);

  if (reasons.length === 0) return { complete: true };
  return {
    complete: false,
    reasons,
    nudge: completionNudge(reasons),
    summary: completionSummary(reasons),
  };
}

/**
 * The preview-failing reason, or null when the gate has nothing to stand on.
 *
 * Deliberately NARROW, because a gate that fires on noise trains everyone to
 * ignore it:
 *
 *   • Only UNCAUGHT exceptions and unhandled rejections fire. Frameworks log
 *     plenty of `console.error` about recoverable conditions (a failed fetch
 *     a catch clause already handled, a React key warning), and gating on
 *     those would nag turns whose page is working.
 *   • Only FRESH issues: the issue must be newer than the workspace revision
 *     the preview could be describing. An exception from code the agent has
 *     since edited is evidence about the old revision — exactly the class of
 *     stale claim the ledger rejects, and for the same reason.
 *   • Only a RUNNING preview. A failed server start says the environment
 *     could not host the app (a native addon, a Node version); that is
 *     already diagnosed and surfaced in the turn note, and it is not work
 *     the agent can fix by continuing.
 *   • Nothing else about the preview gates: not an empty issue list (the app
 *     may simply not have exercised the changed path), not console errors.
 *
 * Every condition below is a way of NOT firing. The one that fires says: the
 * build is green and the page is broken.
 */
function previewFailingReason(input: CompletionInput): IncompleteReason | null {
  const preview = input.preview;
  if (!preview) return null;
  if (preview.status !== "running") return null;
  const fresh = preview.issues.filter(
    (issue) =>
      (issue.kind === "uncaught" || issue.kind === "unhandled-rejection") &&
      issue.at >= preview.workspaceUpdatedAt
  );
  if (fresh.length === 0) return null;
  return {
    kind: "preview-failing",
    issues: fresh.slice(0, 4).map((issue) => issue.message.split("\n")[0] ?? issue.message),
  };
}

/**
 * The untested-change reason, or null when the gate has nothing to stand on.
 *
 * Every condition below is a way of NOT firing:
 *
 *   • no change set, or a project with no tests at all → cannot judge;
 *   • a test file is already part of the change set → the agent did the thing;
 *   • no source file changed (docs, config, lockfiles) → nothing to test;
 *   • no GREEN test command in the evidence → the agent could not run tests
 *     here, and asking for one would be asking for evidence it cannot produce.
 *
 * A deleted source file is not a change that needs a test, so deletions are
 * excluded from the trigger — removing dead code is its own proof.
 */
function untestedChangeReason(input: CompletionInput): IncompleteReason | null {
  const changeSet = input.changeSet;
  if (!changeSet || changeSet.length === 0 || input.projectHasTests !== true) return null;
  if (changeSet.some((c) => isTestPath(c.path))) return null;

  const source = changeSet
    .filter((c) => c.status !== "deleted" && !isTestPath(c.path) && !isNonSourcePath(c.path))
    .map((c) => c.path);
  if (source.length === 0) return null;

  // Either tier counts: a browser workspace and the user's machine are both
  // "the suite ran here", and the reason this gate fires is that the SUITE is
  // green, not that a particular transport produced it.
  const green = input.evidence.find(
    (e) =>
      e.status === "fresh-pass" &&
      (e.kind === "command" || e.kind === "workspace") &&
      TEST_COMMAND_RE.test(e.summary)
  );
  if (!green) return null;

  const match = TEST_COMMAND_RE.exec(green.summary);
  return {
    kind: "untested-change",
    files: source.slice(0, 8),
    run: match ? match[0].replace(/`/g, "") : "the test command",
  };
}
