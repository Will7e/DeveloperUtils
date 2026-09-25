// ============================================================
// Strand Launch — The Engine-Side Join (Braid P2)
// ============================================================
// The one place that ties fork → strands → decide → adopt together.
// Called by the turn engine when a turn is at risk (shouldForkStrands'
// risk signals) and joined at the stop. Strands run PAGE-SIDE,
// concurrently with the main turn: the user sees the main loop keep
// working; nothing blocks on a strand until the join.
//
// Caps, all enforced HERE (strand.ts trusts its caller): one fork
// event per turn, ≤2 strands, 8 rounds each, and the session abort
// controller as the kill switch (stopTurn already aborts it).
//
// Isolation invariant: a strand NEVER touches the live workspace
// value. Its executor mutates only the fork's copy; adoption
// materializes the winner with a revision bump; a main-path win
// requires no restore because there is nothing to undo.

import { forkWorkspace } from "./fork";
import { createStrandExecutor } from "./strand-exec";
import {
  STRAND_TOOL_NAMES,
  pickStrandModels,
  runStrand,
  shouldForkStrands,
  STRAND_MAX_CONCURRENT,
  STRAND_MAX_ROUNDS,
  type StrandResult,
} from "./strand";
import { braidNote, decideBraid, workspaceChangeStats, type BraidDecision } from "./braid-decide";
import { TOOL_REGISTRY } from "../lib/tool-registry";
import { nextRevision } from "../identity/revision";
import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import type { ToolDefinition, WorkspaceState } from "../types";

/** Tools offered to strands: registry descriptions, strand-surface filtered */
const STRAND_TOOLS: ToolDefinition[] = TOOL_REGISTRY.filter((t) =>
  STRAND_TOOL_NAMES.has(t.name)
).map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: `${t.description} (strand: works on the forked workspace copy)`,
    parameters: t.parameters as unknown as Record<string, unknown>,
  },
}));

/** The strand system prompt: restriction rules + task */
export function strandSystemPrompt(task: string, repoLabel: string): string {
  return [
    "You are a strand rollout: a bounded, parallel attempt at the task below, running on an ISOLATED FORK of the workspace.",
    "Your work is compared against the main agent's turn at the end; whichever verifies better is kept. You may be discarded entirely.",
    "",
    "Hard rules:",
    "- You may only read, edit and check code in your fork. Pushing, MCP calls, app tools, previews and asking the user are NOT available and will be refused.",
    "- Work surgically toward the task. Prefer the smallest change that verifies.",
    "- Call run_checks to verify before you stop; a strand that ends without a green check is discarded first.",
    "",
    `Repository: ${repoLabel}`,
    "",
    "TASK:",
    task,
  ].join("\n");
}

/** The wire task message, with fork orientation */
export function strandTaskMessage(task: string): Record<string, unknown> {
  return {
    role: "user",
    content:
      `${task}\n\n` +
      "(You are working an isolated fork of the workspace. Your file tools read and write that fork; " +
      "run_checks checks the fork's own files. Finish by verifying, then stop with a one-paragraph summary.)",
  };
}

export interface StrandLaunchContext {
  conversationId: string;
  /** The conversation's model — the ceiling strands run at or below */
  conversationModel: string;
  /** Cheaper models to consider for strands (catalog-provided) */
  cheaperModels: string[];
  apiKey: string;
  token: string;
  /** Repo label for the strand prompt */
  repoLabel: string;
  /** The task text (the user's latest message) */
  task: string;
  /** Risk signals for the fork policy */
  signals: {
    stuckRefusals: number;
    probeFailures: number;
    checkFailing: boolean;
    plan: { total: number; done: number };
    roundsSpent: number;
  };
  signal: AbortSignal;
}

/** The background handle the engine holds between launch and join */
export interface StrandLaunchHandle {
  forked: true;
  reason: string;
  /** Labels, for the transcript note */
  label: string;
  roundsPerStrand: number;
  /** Joins at the stop: decides, materializes the winner, returns the note */
  join: (mainWs: WorkspaceState, mainVerified: boolean) => Promise<string | null>;
}

interface StrandRunOutcome {
  results: StrandResult[];
  /** Each strand's executor final fork value, index-aligned with results */
  finals: WorkspaceState[];
  /** The fork snapshot's revision — the staleness yardstick (NOT a timestamp) */
  forkedAtRevision: number;
}

/**
 * Fires strands when the risk policy says so. Returns a handle whose
 * `join` is awaited at the stop — or null when the policy declines
 * (the common case: a healthy turn forks nothing).
 */
export function maybeLaunchStrands(
  ctx: StrandLaunchContext,
  /** The live workspace value to fork (read once, from the store) */
  liveWs: WorkspaceState | null,
  /** Called with the join note, so the engine owns the transcript */
  onNote: (note: string) => void
): StrandLaunchHandle | null {
  const policy = shouldForkStrands(ctx.signals);
  if (!policy.fork) return null;
  if (!liveWs) return null;

  const fork = forkWorkspace(liveWs);
  const labels = ["strand A", "strand B"].slice(0, STRAND_MAX_CONCURRENT);
  const models = pickStrandModels(ctx.conversationModel, ctx.cheaperModels, labels.length);
  const executors = labels.map(() => createStrandExecutor(fork.snapshot, ctx.token, ctx.signal));

  const run: Promise<StrandRunOutcome | null> = (async () => {
    try {
      const results = await Promise.all(
        labels.map((label, i) =>
          runStrand({
            conversationId: ctx.conversationId,
            label,
            modelId: models[i]!,
            apiKey: ctx.apiKey,
            tools: STRAND_TOOLS,
            systemPrompt: strandSystemPrompt(ctx.task, ctx.repoLabel),
            messages: [strandTaskMessage(ctx.task)],
            signal: ctx.signal,
            execute: (call) => executors[i]!.execute(call),
          })
        )
      );
      return {
        results,
        finals: executors.map((e) => e.ws),
        forkedAtRevision: fork.forkedAtRevision,
      };
    } catch {
      return null; // the join treats null as "no strands ran"
    }
  })();

  return {
    forked: true,
    reason: policy.reason,
    label: labels.join(" + "),
    roundsPerStrand: STRAND_MAX_ROUNDS,
    join: (mainWs, mainVerified) =>
      joinStrands(run, ctx.conversationId, mainWs, mainVerified, onNote),
  };
}

/**
 * The staleness test, exported pure for tests: a fork is stale exactly
 * when the live workspace's revision has moved past the revision the
 * fork captured. Both sides are REVISIONS (workspace.updatedAt), which
 * only move on edits — never timestamps.
 */
export function strandForkIsStale(liveUpdatedAt: number, forkedAtRevision: number): boolean {
  return liveUpdatedAt !== forkedAtRevision;
}
async function joinStrands(
  run: Promise<StrandRunOutcome | null>,
  conversationId: string,
  mainWs: WorkspaceState,
  mainVerified: boolean,
  onNote: (note: string) => void
): Promise<string | null> {
  const outcome = await run;
  if (!outcome || outcome.results.length === 0) return null;
  const { results, finals } = outcome;

  // STALENESS RULE: the strands forked at a REVISION of the working copy.
  // If the live workspace's revision has moved past it, the main turn
  // edited after the fork — every fork is a copy of a state the main path
  // has already superseded, and adopting one would erase real work. The
  // main path wins automatically, whatever the strands achieved. This is
  // the correctness guarantee that makes shadow strands safe to run.
  if (strandForkIsStale(mainWs.updatedAt, outcome.forkedAtRevision)) {
    const note = braidNote(
      { winner: "main", reason: "the main turn kept editing after the fork, so the strands' forks were stale" },
      results.map((r) => r.label)
    );
    if (note) onNote(note);
    return note;
  }

  const decision = decideBraid(
    {
      verified: mainVerified,
      stats: workspaceChangeStats(mainWs),
      modelId: "",
    },
    results.map((r, i) => ({
      label: r.label,
      modelId: r.modelId,
      verified: r.verified,
      stats: workspaceChangeStats(finals[i] ?? mainWs),
    }))
  );

  if (decision.winner === "strand") {
    const idx = results.findIndex((r) => r.label === decision.label);
    const strandFinal = finals[idx];
    // LAST-INSTANT STALENESS RE-CHECK: the join may have been delayed
    // (timeout race, slow strand tail). Re-reading the CURRENT workspace
    // revision and refusing to adopt when it moved prevents a late
    // setWorkspace from wiping work the user's next turn already did.
    const currentWs = selectWorkspaceSafely(conversationId);
    if (
      strandFinal &&
      currentWs &&
      !strandForkIsStale(currentWs.updatedAt, outcome.forkedAtRevision)
    ) {
      // Materialize the winner: the strand's exact bytes, revision bumped
      // strictly past both the strand's and the live workspace's, so any
      // evidence recorded against the replaced state goes stale.
      useChatStore.getState().setWorkspace(
        conversationId,
        nextRevisionValue(strandFinal, currentWs)
      );
    } else if (strandFinal) {
      const note = braidNote(
        { winner: "main", reason: "the workspace moved while the strands were being joined" },
        results.map((r) => r.label)
      );
      if (note) onNote(note);
      return note;
    }
  }
  // main wins → nothing to do: the strands never touched the live value.

  const note = braidNote(decision, results.map((r) => r.label));
  if (note) onNote(note);
  return note;
}

function nextRevisionValue(strandFinal: WorkspaceState, live: WorkspaceState): WorkspaceState {
  return { ...strandFinal, updatedAt: nextRevision(Math.max(strandFinal.updatedAt, live.updatedAt)) };
}

/**
 * Reads the conversation's CURRENT workspace at join time through the
 * store's own binding-checked accessor — a thread that detached mid-turn
 * simply has nothing to adopt into.
 */
function selectWorkspaceSafely(conversationId: string): WorkspaceState | null {
  try {
    return selectWorkspace(useChatStore.getState(), conversationId);
  } catch {
    return null;
  }
}

export type { BraidDecision };
