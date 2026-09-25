// ============================================================
// Difficulty — How Hard Is This Turn Going, From Facts Already Held
// ============================================================
// "The model is struggling" used to be one boolean somewhere else:
// `stuckRefusals > 0` handed the turn to a stronger model the moment a
// repeated failing call was refused. Every other signal the harness
// already produces — failed calls, alternating retry loops, argument
// repairs, a check that failed against the current code, a nudged
// completion — was either thrown away or read by exactly one consumer.
//
// This module is the shared read on those facts. One assessment per
// round, three levels, and — because a score the consumer cannot
// interrogate is a score the consumer cannot trust — the named signals
// that produced it. Escalation quotes those names in the transcript,
// the same honesty rule `pickEscalationTarget` already follows: a
// change the user cannot explain is a change they cannot trust.
//
// Pure by design: no stores, no clock, no I/O. Everything arrives as
// input, so every threshold here is unit-tested without a turn engine.
// Weights are exported constants rather than literals because a weight
// nobody can see is a weight nobody can tune against a transcript.

/** How hard a turn is working, in the order the ladder consumes it */
export type DifficultyLevel = "low" | "elevated" | "high";

/**
 * One contributing fact. `weight` is the score it added — so a reader
 * of the transcript can see not just THAT the turn was judged stuck
 * but which facts pushed it there.
 */
export interface DifficultySignal {
  /** Stable machine name (turn log, tests) */
  name: string;
  /** Human-readable basis (transcript notes) */
  detail: string;
  weight: number;
}

export interface DifficultyAssessment {
  level: DifficultyLevel;
  /** Raw weighted score — exposed so thresholds can be reasoned about */
  score: number;
  /** Every signal that contributed, strongest first */
  signals: DifficultySignal[];
}

export interface DifficultyInput {
  /** ── Call-ledger facts (session.callLedger, already maintained) ── */
  /** Entries in the ledger whose last execution FAILED */
  failedCalls: number;
  /** Highest execution count on any one signature (repeat loops) */
  mostRepeatedCall: number;
  /**
   * Number of signatures whose execution counts went UP then DOWN then
   * UP again this turn — the A→B→A→B shape the per-signature repeat
   * counter cannot see. One alternation cycle is a legitimate
   * read-after-edit; several are a model oscillating.
   */
  alternatingPairs: number;
  /** ── Round-outcome facts (already counted by the executor) ── */
  /** Calls the repetition policy or surface check REFUSED this turn */
  stuckRefusals: number;
  /** Calls whose arguments were repaired before they could run */
  argumentRepairs: number;
  /** Batches the loop auto-continued (a cap-sized tool loop) */
  continuations: number;
  /** Completion-gate nudges spent (the model stopped with work open) */
  completionNudges: number;
  /** ── Evidence facts (verification ledger, revision-checked) ── */
  /** Checks that FAILED against the code in the workspace right now */
  freshFailingChecks: number;
  /** Fresh uncaught exceptions on the RUNNING preview, if one is live */
  freshPreviewErrors: number;
}

// ── Weights ──────────────────────────────────────────────────
// Chosen so that the levels mean:
//   low      — a normal working turn; the ladder does nothing
//   elevated — friction is accumulating; knowledge and thinking help
//   high     — the turn is provably stuck; a stronger model may help

/** Each distinct failing call, after the first (the first is just work) */
export const WEIGHT_FAILED_CALL = 2;
/** Same signature executed again beyond the second execution */
export const WEIGHT_REPEAT_EXECUTION = 3;
/** Each A→B→A alternation cycle beyond the first (legitimate after an edit) */
export const WEIGHT_ALTERNATION = 4;
/** Each refusal the repetition/surface policy handed out */
export const WEIGHT_STUCK_REFUSAL = 6;
/** Each argument repair (the call was wrong but could be salvaged) */
export const WEIGHT_ARGUMENT_REPAIR = 1;
/** Each auto-continuation of a cap-sized tool loop */
export const WEIGHT_CONTINUATION = 3;
/** Each completion-gate continuation (the model stopped with work open) */
export const WEIGHT_COMPLETION_NUDGE = 4;
/** Each check that failed against the CURRENT revision */
export const WEIGHT_FRESH_FAILING_CHECK = 3;
/** Each fresh uncaught exception on the running preview */
export const WEIGHT_FRESH_PREVIEW_ERROR = 3;

/** Score at which a turn stops being `low` */
export const ELEVATED_THRESHOLD = 6;
/** Score at which the turn is considered genuinely stuck */
export const HIGH_THRESHOLD = 14;

/** Caps for per-kind accumulations, so no single signal class dominates */
const MAX_FAILED_CALL_WEIGHT = 8;
const MAX_REPEAT_WEIGHT = 9;
const MAX_ALTERNATION_WEIGHT = 8;

/**
 * Assesses how hard this turn is working, from facts the engine already
 * holds. Levels, in the order the response ladder consumes them:
 *
 *   low      — normal work. No intervention.
 *   elevated — friction is real (failures, repairs, a failing check).
 *              The cheap responses — load the relevant knowledge, let
 *              the model think longer — are worth trying first.
 *   high     — the turn is provably stuck. A stronger model may be the
 *              right response, and the existing escalation policy acts.
 */
export function assessDifficulty(input: DifficultyInput): DifficultyAssessment {
  const signals: DifficultySignal[] = [];

  const failedWeight = Math.min(
    Math.max(0, input.failedCalls - 1) * WEIGHT_FAILED_CALL,
    MAX_FAILED_CALL_WEIGHT
  );
  if (failedWeight > 0) {
    signals.push({
      name: "failed-calls",
      detail: `${input.failedCalls} tool call failures this turn`,
      weight: failedWeight,
    });
  }

  // A call executed more than twice this turn is a loop the ledger caught
  // (the repetition policy starts acting at three). Beyond two executions
  // each further one adds weight — bounded, so one pathological signature
  // cannot dominate the whole assessment on its own.
  const repeats = Math.max(0, input.mostRepeatedCall - 2);
  const repeatWeight = Math.min(repeats * WEIGHT_REPEAT_EXECUTION, MAX_REPEAT_WEIGHT);
  if (repeatWeight > 0) {
    signals.push({
      name: "repeated-call",
      detail: `one call ran ${input.mostRepeatedCall} times`,
      weight: repeatWeight,
    });
  }

  // Alternation cycles are counted BEYOND the first on purpose: one
  // read-after-edit alternation is correct agentic behaviour, not friction.
  const alternations = Math.max(0, input.alternatingPairs - 1);
  const alternationWeight = Math.min(
    alternations * WEIGHT_ALTERNATION,
    MAX_ALTERNATION_WEIGHT
  );
  if (alternationWeight > 0) {
    signals.push({
      name: "alternating-calls",
      detail: `${input.alternatingPairs} calls alternate without converging`,
      weight: alternationWeight,
    });
  }

  if (input.stuckRefusals > 0) {
    signals.push({
      name: "stuck-refusals",
      detail:
        `${input.stuckRefusals} call${input.stuckRefusals === 1 ? "" : "s"} refused — ` +
        "the same failing call was repeated after being told it fails",
      weight: input.stuckRefusals * WEIGHT_STUCK_REFUSAL,
    });
  }

  if (input.argumentRepairs > 0) {
    signals.push({
      name: "argument-repairs",
      detail: `${input.argumentRepairs} call${input.argumentRepairs === 1 ? "" : "s"} needed argument repair`,
      weight: input.argumentRepairs * WEIGHT_ARGUMENT_REPAIR,
    });
  }

  if (input.continuations > 0) {
    signals.push({
      name: "auto-continuations",
      detail: `${input.continuations} cap-sized batch${input.continuations === 1 ? "" : "es"} auto-continued`,
      weight: input.continuations * WEIGHT_CONTINUATION,
    });
  }

  if (input.completionNudges > 0) {
    signals.push({
      name: "completion-nudges",
      detail: `${input.completionNudges} completion continuation${input.completionNudges === 1 ? "" : "s"} — stopped with work open`,
      weight: input.completionNudges * WEIGHT_COMPLETION_NUDGE,
    });
  }

  if (input.freshFailingChecks > 0) {
    signals.push({
      name: "failing-checks",
      detail: `${input.freshFailingChecks} check${input.freshFailingChecks === 1 ? "" : "s"} failing against the current code`,
      weight: input.freshFailingChecks * WEIGHT_FRESH_FAILING_CHECK,
    });
  }

  if (input.freshPreviewErrors > 0) {
    signals.push({
      name: "preview-errors",
      detail: `${input.freshPreviewErrors} uncaught error${input.freshPreviewErrors === 1 ? "" : "s"} on the running app`,
      weight: input.freshPreviewErrors * WEIGHT_FRESH_PREVIEW_ERROR,
    });
  }

  // Strongest first: the transcript note and the turn log both read
  // front-to-back, and the heaviest fact is the one a reader needs first.
  signals.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  const level: DifficultyLevel =
    score >= HIGH_THRESHOLD ? "high" : score >= ELEVATED_THRESHOLD ? "elevated" : "low";
  return { level, score, signals };
}

/** One line for the transcript/turn log: the level and its named basis */
export function describeDifficulty(assessment: DifficultyAssessment): string {
  if (assessment.signals.length === 0) return "difficulty: low (no friction signals)";
  return (
    `difficulty: ${assessment.level} (score ${assessment.score}) — ` +
    assessment.signals.map((s) => `${s.detail} (+${s.weight})`).join("; ")
  );
}

/**
 * Counts A→B→A alternation cycles in a call-signature execution order.
 *
 * The per-signature ledger cannot see this shape — it knows one call ran
 * three times, not that the model oscillated between two failing calls.
 * One cycle is allowed for free by the caller's weighting (a read after
 * an edit is correct agentic behaviour); the weight is applied beyond it.
 *
 * Non-overlapping on purpose: A→B→A→B counts ONE cycle, not two — the
 * honest count of distinct oscillations, not a length proxy.
 */
export function countAlternationCycles(order: readonly string[]): number {
  let cycles = 0;
  let i = 0;
  while (i + 2 < order.length) {
    if (order[i] === order[i + 2] && order[i] !== order[i + 1]) {
      cycles += 1;
      i += 3;
    } else {
      i += 1;
    }
  }
  return cycles;
}
