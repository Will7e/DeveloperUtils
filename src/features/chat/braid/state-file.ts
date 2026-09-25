// ============================================================
// State File — Fixed-Size Working State (Braid P3)
// ============================================================
// Context rot (Chroma, 2025) is the reason long agent turns degrade:
// every fact the model needs competes with every fact it no longer
// does, and the rolling summary grows monotonically to carry both.
// The fix here is not a better summarizer — it is deriving what CAN be
// derived deterministically, every round, from sources the harness
// already holds, and keeping THAT as the fixed-size state instead of
// an ever-growing prose ledger:
//
//   • GOAL from the last user message (verbatim, capped)
//   • DECISIONS from the agent's own plan updates (plan-action ledger)
//   • FACTS from completed plan steps and recorded verification
//   • OPEN THREADS from unfinished steps, failing checks, probe
//     diagnostics, unresolved asks
//   • NEXT ACTION from the first unfinished step — or, when the gate
//     already decided the turn is over, nothing
//
// Zero model calls in the default mode: this file is rebuilt per turn
// from plan + evidence, so it cannot hallucinate, it costs no tokens
// to maintain, and — the point — it CANNOT GROW. Every field is
// capped; rendering is byte-stable within a turn (cache safety); and
// when no state is derivable, callers fall back to the prose summary
// exactly as before.
//
// The engine calls `rebuildBraidState` at round boundaries and turns;
// compaction folds AGAINST it (see the integration in compaction.ts).

import type { AgentPlan } from "../types";
import type { VerificationEvidence } from "../lib/verification-ledger";
import { planProgress } from "../lib/agent-plan";

export interface BraidState {
  /** The task, from the newest user message */
  goal: string;
  /** Decisions the agent committed to (from its plan steps' own words) */
  decisions: string[];
  /** Established facts: completed steps, green checks */
  facts: string[];
  /** Unresolved things: open steps, failing checks, fresh probe findings */
  openThreads: string[];
  /** The single next action, or null when the work is settled */
  nextAction: string | null;
  /** The revision this state describes */
  workspaceUpdatedAt: number | null;
  rebuiltAt: number;
}

/** Field caps — the state cannot grow past these, ever */
export const BRAID_STATE_MAX_DECISIONS = 8;
export const BRAID_STATE_MAX_FACTS = 8;
export const BRAID_STATE_MAX_THREADS = 8;
export const BRAID_STATE_FIELD_MAX_CHARS = 200;
export const BRAID_STATE_GOAL_MAX_CHARS = 400;

/** Probe findings pulled from the transcript, newest note first */
export const PROBE_FINDINGS_MAX = 6;

/** The minimal message shape the extractor reads — no store, no worker */
export interface ProbeSourceMessage {
  role: string;
  content: string;
  toolResult?: unknown;
}

/**
 * Pulls fresh probe findings out of the transcript.
 *
 * The engine's mid-turn probe (braid/probe.ts) reports through harness notes —
 * assistant rows whose content starts with "[harness probe]" — so the round
 * boundary that prepares the next request can recover what those probes found
 * without threading engine state into turn-prep. Only rows AFTER the newest
 * user message are read: they are THIS turn's probes, not the previous
 * turn's. Newest note first (a later note supersedes an earlier one), capped.
 */
export function probeFindingsFromTranscript(messages: ProbeSourceMessage[]): string[] {
  const findings: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && m.toolResult === undefined) break;
    if (m.role !== "assistant" || !m.content.startsWith("[harness probe]")) continue;
    for (const line of m.content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) findings.push(trimmed.slice(2));
    }
  }
  return findings.slice(0, PROBE_FINDINGS_MAX);
}

/** Input sources — all already in memory at any round boundary */
export interface BraidStateInput {
  taskText: string;
  plan?: AgentPlan | null;
  evidence: VerificationEvidence[];
  /** Fresh probe diagnostics from this turn (braid/probe.ts), if any */
  probeFindings?: string[];
  /** True when the completion gate's latest verdict was complete */
  turnSettled?: boolean;
  workspaceUpdatedAt?: number | null;
}

/** Rebuilds the working state from current sources. Pure and cheap. */
export function rebuildBraidState(input: BraidStateInput): BraidState {
  const progress = planProgress(input.plan ?? undefined);
  const steps = input.plan?.steps ?? [];

  const decisions = steps
    .filter((s) => s.status === "done" || s.status === "active")
    .slice(0, BRAID_STATE_MAX_DECISIONS)
    .map((s) => clip(s.text));

  // Every loop checks BEFORE pushing: the cap is a hard invariant, and a
  // push-then-check would let each additional source overshoot by one.
  const facts: string[] = [];
  for (const step of steps) {
    if (facts.length >= BRAID_STATE_MAX_FACTS) break;
    if (step.status === "done") facts.push(clip(`step done: ${step.text}`));
  }
  for (const entry of input.evidence) {
    if (facts.length >= BRAID_STATE_MAX_FACTS) break;
    if (entry.status !== "fresh-pass") continue;
    facts.push(clip(`${entry.summary} (${entry.kind}, verified this revision)`));
  }

  const openThreads: string[] = [];
  for (const step of steps) {
    if (openThreads.length >= BRAID_STATE_MAX_THREADS) break;
    if (step.status !== "done") openThreads.push(clip(`step open: ${step.text}`));
  }
  for (const entry of input.evidence) {
    if (openThreads.length >= BRAID_STATE_MAX_THREADS) break;
    if (entry.status !== "fresh-fail") continue;
    openThreads.push(clip(`${entry.summary} (${entry.kind} failing)`));
  }
  for (const finding of input.probeFindings ?? []) {
    if (openThreads.length >= BRAID_STATE_MAX_THREADS) break;
    openThreads.push(clip(`probe: ${finding}`));
  }

  const nextAction =
    input.turnSettled || openThreads.length === 0
      ? null
      : progress.next
        ? clip(progress.next.text)
        : clip(openThreads[0]!);

  return {
    goal: clip(input.taskText.trim() || "(in progress)", BRAID_STATE_GOAL_MAX_CHARS),
    decisions,
    facts,
    openThreads,
    nextAction,
    workspaceUpdatedAt: input.workspaceUpdatedAt ?? null,
    rebuiltAt: Date.now(),
  };
}

/** Renders the state as the compact block that replaces "growing ledger" prose */
export function renderBraidState(state: BraidState): string {
  const lines: string[] = ["WORKING STATE (fixed-size, rebuilt each turn):"];
  lines.push(`GOAL: ${state.goal}`);
  if (state.decisions.length > 0) {
    lines.push("DECISIONS:");
    for (const d of state.decisions) lines.push(`- ${d}`);
  }
  if (state.facts.length > 0) {
    lines.push("FACTS:");
    for (const f of state.facts) lines.push(`- ${f}`);
  }
  if (state.openThreads.length > 0) {
    lines.push("OPEN THREADS:");
    for (const t of state.openThreads) lines.push(`- ${t}`);
  }
  if (state.nextAction) lines.push(`NEXT ACTION: ${state.nextAction}`);
  return lines.join("\n");
}

function clip(text: string, max = BRAID_STATE_FIELD_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
