// ============================================================
// Turn Engine — The One Place Turn Semantics Live
// ============================================================
// Both transports (SharedWorker host, page-local) drive the same
// HostTurnController and emit the same HostEvent stream, so this
// engine owns every turn rule exactly once:
//
//  - rounds: prepare → start → render → (tool calls? run them → next
//    round). Tool EXECUTION stays here because the workspace lives in
//    the page.
//  - the renderer, including an inactivity watchdog: silence from
//    the transport (killed worker, dropped port) ends the turn with
//    an honest error instead of a spinner that never stops.
//  - the fallback rule: if the survivable transport refuses or dies
//    before anything was committed, retry the round once on the
//    page-local transport. Never duplicate already-committed output.
//  - commit semantics per end reason, token calibration, and clearing
//    the pending-turn marker on every exit path.
//
// State lives in ONE explicit session object PER CONVERSATION (no ambient
// module flags), and a turn is single-flight WITHIN its conversation: a second
// run of the same chat while it is running is refused rather than interleaved,
// while a different chat starts its own turn — which is what makes several
// agents able to work at once. The turn-scoped things (abort controller, call
// ledger, tool surface, escalated model) are per-conversation for the same
// reason: they describe a turn, and two turns do not share one.

import { useChatStore, selectWorkspace } from "@/stores/chat.store";
import {
  prepareTurn,
  resolveModelState,
  type PreparedTurn,
  type TurnPreparation,
} from "../services/turn-prep";
import { executeToolCall, serializeToolResult, parseToolArguments } from "../lib/tools";
import {
  lookupToolCache,
  readViewFor,
  storeToolCache,
  toolCacheKey,
} from "../lib/tool-cache";
import {
  validateToolCall,
  getToolMeta,
  isPlanSafeTool,
  isRepoFreeTool,
  isValidToolName,
} from "../lib/tool-registry";
import {
  callSignature,
  extractTextToolCalls,
  noToolCallNudge,
  recoveredToolCalls,
  refuseResultText,
  repairToolArguments,
  repeatDecision,
  reuseResultText,
  type CallLedgerEntry,
} from "../lib/tool-repair";
import {
  getCachedModelCatalog,
  getCompetenceIndex,
  modelDisplayName,
} from "../lib/model-catalog";
import {
  canEscalate,
  escalationNote,
  noEscalationReason,
  pickEscalationTarget,
  type EscalationOptions,
  type EscalationTargetChoice,
} from "../lib/escalation";
import { evaluateCompletion, type CompletionVerdict } from "../lib/completion-gate";
import {
  assessDifficulty,
  countAlternationCycles,
  describeDifficulty,
  type DifficultyAssessment,
} from "../lib/difficulty";
import {
  effortBumpLogDetail,
  effortEscalationNote,
  pickEffortBump,
  type EffortBumpChoice,
} from "../lib/effort-escalation";
import { classifyRequest, effortForComplexity } from "../lib/task-complexity";
import { resolveModelInfo } from "../lib/model-catalog";
import {
  argumentRepairNote,
  withContractHint,
  withheldRefusal,
} from "../lib/tool-surface";
import { continuationExhaustedNotice, TOOL_LIMIT_NOTICE } from "../lib/harness-notices";
import { livePreviewState, previewOwnerThreadId } from "../container/preview-bridge";
import { verificationEvidence } from "../lib/verification-ledger";
import { collectChanges } from "../workspace/workspace";
import { isTestPath } from "../lib/project-fingerprint";
import { recordUsageCalibration } from "../context/tokenizer-calibration";
import { estimateTokens, estimateToolSchemaTokens } from "../context/tokenizer";
import {
  AGENT_AUTO_CONTINUATIONS,
  AGENT_COMPLETION_NUDGES,
  AGENT_ITERATIONS,
  CURATED_FALLBACK_MODELS,
  DEFAULT_CHAT_MODE,
  DEFAULT_REASONING_EFFORT,
  TOOL_EXECUTION_CONCURRENCY,
  TURN_INACTIVITY_TIMEOUT_MS,
} from "../constants";
import type { ToolDefinition } from "../types";
import { runUpdatePlan } from "../services/plan-actions";
import {
  runCallMcpTool,
  runCreateWorkingBranch,
  runDelegate,
  runDeleteFile,
  runEditFile,
  runListMcpTools,
  runPushChanges,
  runPreviewEvaluate,
  runPreviewInteract,
  runPreviewSnapshot,
  runReadPreview,
  runReadProcess,
  runRemember,
  runRunChecks,
  runCiVerification,
  runSearchWorkspace,
  runShellCommand,
  runStartProcess,
  runStopProcess,
  runWaitForPreview,
  runWorkspaceDiff,
  runWriteFile,
} from "../services/agent-actions";
import {
  runCommentOnIssue,
  runCreateIssue,
  runListIssues,
  runListPullRequests,
  runReadCiLogs,
  runReadIssue,
  runReadPullRequest,
  runReviewPullRequest,
  runUpdatePullRequest,
} from "../services/github-collab-actions";
import { runAppTool } from "../services/app-actions";
import { registerScopedResource } from "../identity/scoped-resources";
// The Stop note a dismissed approval carries, so a gate closed by "stop" reads
// to the model as the user stopping the work rather than rejecting a change.
import { STOPPED_BY_USER } from "../lib/user-stop";
import { runAskUser, runSuggestNext, settlePendingQuestion } from "../services/ask-user";
import {
  captureProbeBaseline,
  diffProbe,
  probeFiles,
  probeNotice,
  type ProbeBaseline,
} from "../braid/probe";
import { maybeLaunchStrands, type StrandLaunchHandle } from "../braid/strand-launch";
import { distillTurn, estimateDistillTokens } from "../braid/distill";
import type { StrategyEntry } from "../braid/strategy-store";
import { sessionHost } from "./session-client";
import { HostTurnSource, LocalTurnSource, type StartOutcome, type TurnSource } from "./turn-source";
import { getTurnLog, logTurnEvent } from "./turn-log";
import { clearEnvSkillState } from "../services/turn-prep";
import type {
  HostEndReason,
  HostEvent,
  HostSnapshot,
  HostStartTurnPayload,
  HostUsage,
} from "./protocol";
import { visibleMessages } from "../types";
import type {
  ChatConversation,
  ChatMode,
  ReasoningEffort,
  RepoContext,
  ToolCallRequest,
  ToolCallResult,
  ToolName,
  UsageInfo,
} from "../types";

// ── Explicit session state ──────────────────────────────────

export interface TurnSessionState {
  phase: "idle" | "running";
  conversationId: string | null;
  /** The transport currently owning the turn */
  source: TurnSource | null;
  /** Id of the turn being rendered (null before start) */
  turnId: string | null;
  /** Cancellation for the pre-stream phase (prepare/compaction) */
  abort: AbortController | null;
  /** Tool calls handed over by the last rendered round */
  toolCalls: ToolCallRequest[];
  /** True while page-side tool execution is in flight */
  inToolPhase: boolean;
  /**
   * Per-turn execution ledger: call signature → how often it ran and
   * whether it worked. This is what makes the loop self-correcting —
   * a third identical successful call is answered from the ledger
   * instead of re-running, and a third identical FAILING call is
   * refused with a demand to change approach.
   */
  callLedger: Map<string, CallLedgerEntry>;
  /** True once text-emitted tool calls have been recovered this turn */
  recoveredTextCalls: boolean;
  /** Harness note to attach to the recovered calls' transcript row */
  recoveredNote: string | null;
  /** Model state the current round was prepared with (message metadata) */
  effort: ReasoningEffort;
  mode: ChatMode;
  /**
   * Model the rest of this turn continues on, set after an escalation
   * (lib/escalation.ts). Null while the turn runs on the conversation's
   * own model. Cleared when the turn ends — a swap is a property of the
   * turn, never of the conversation.
   */
  modelOverride: string | null;
  /** True once this turn spent its single escalation */
  escalated: boolean;
  /**
   * Effort rung the rest of this turn continues at, set after an effort
   * bump (lib/effort-escalation.ts). Null while the turn runs at the
   * conversation's own rung. Dies with the turn, exactly like the model
   * override: the conversation's effort setting is the user's.
   */
  effortOverride: ReasoningEffort | null;
  /** True once this turn spent its single effort bump */
  effortBumped: boolean;
  /** The latest difficulty assessment for this turn (turn log, tests) */
  difficulty: DifficultyAssessment | null;
  /** Probe baseline captured at turn start (Braid P1); null until the first run */
  probeBaseline: ProbeBaseline | null;
  /** Probe runs that reported new diagnostics this turn (risk signal) */
  probeFailures: number;
  /** Workspace revision the last probe read (cost gate: skip identical re-reads) */
  lastProbeRevision: number;
  /** Strand fork event for this turn, when one fired (Braid P2) */
  strandHandle: StrandLaunchHandle | null;
  /**
   * Names of the tools the CURRENT round was sent.
   *
   * The surface is what the model was OFFERED, which is not the same as what is
   * registered: a lean-profile turn withholds `http_write`, `create_diagram` and
   * `open_in_tool`, and a plan turn withholds every mutating tool. A call for a
   * name outside this set is refused by the executor, because a model that was
   * never offered a tool cannot legitimately invoke it — that call is a
   * hallucination or a stale transcript, and running it was how a free model
   * reached a tool its own profile had deliberately removed.
   *
   * null means "unknown" (an adopted turn, or a path that never prepared a
   * request): unknown does NOT refuse, because refusing on a guess would break
   * real turns to catch a hypothetical one.
   */
  sentToolNames: Set<string> | null;
  /**
   * Count of calls the repetition policy had to REFUSE this turn because
   * the model kept repeating a failing one. A refusal only happens after
   * the same call has failed twice and been demanded to change, so one
   * refusal is already "the model is stuck" — and it is the signal
   * escalation acts on.
   */
  stuckRefusals: number;
}

/**
 * The state of a conversation that is not running anything.
 *
 * Handed back by the accessors below rather than kept as a tombstone in the
 * map: a finished turn leaves no record, so nothing can read a stale tool
 * surface, ledger or escalated model off a turn that is over.
 */
function idleSession(conversationId: string | null): TurnSessionState {
  return {
    phase: "idle",
    conversationId,
    source: null,
    turnId: null,
    abort: null,
    toolCalls: [],
    inToolPhase: false,
    callLedger: new Map(),
    recoveredTextCalls: false,
    recoveredNote: null,
    effort: DEFAULT_REASONING_EFFORT,
    mode: DEFAULT_CHAT_MODE,
    modelOverride: null,
    escalated: false,
    effortOverride: null,
    effortBumped: false,
    difficulty: null,
    stuckRefusals: 0,
    probeBaseline: null,
    probeFailures: 0,
    lastProbeRevision: -1,
    strandHandle: null,
    sentToolNames: null,
  };
}

/**
 * Live turns, ONE PER CONVERSATION.
 *
 * The map is the multi-tenancy. A turn reads and writes only its own entry, so
 * two conversations streaming at once cannot reach each other's abort signal,
 * call ledger, sent-tool surface or escalated model. Entries are removed when
 * the turn ends, so "is this thread running?" is answered by presence rather
 * than by a flag some exit path has to remember to clear.
 */
const sessions = new Map<string, TurnSessionState>();

/** This conversation's turn state, creating it as the turn starts */
function sessionOf(conversationId: string): TurnSessionState {
  const existing = sessions.get(conversationId);
  if (existing) return existing;
  const created = idleSession(conversationId);
  sessions.set(conversationId, created);
  return created;
}

/** This conversation's turn state when it has a turn in flight, else null */
function runningSession(conversationId: string): TurnSessionState | null {
  const state = sessions.get(conversationId);
  return state && state.phase === "running" ? state : null;
}

/** Identical executions allowed before the ledger takes over */
const REPEAT_MAX_EXECUTIONS = 2;
/**
 * Stand-in repo for the read tools that need none (see the read pass in
 * executeToolPhase). Only ever handed to tools the registry marks `repoFree`,
 * and none of them reads a field off it.
 */
const EMPTY_REPO_CONTEXT: RepoContext = { owner: "", repo: "", branch: "", attachedAt: 0 };
/**
 * In-place retries for a round that died with NOTHING rendered.
 *
 * A dropped stream with nothing on screen is not a loss the user should
 * have to act on: telling them to "send again" is asking them to be the
 * retry loop. One extra attempt cannot duplicate output (nothing was
 * committed), so it is spent before the turn admits defeat.
 */
const LOST_ROUND_RETRIES = 1;
/** Serialized result kept in the ledger for a reuse (bounded) */
const LEDGER_RESULT_MAX_CHARS = 4_000;

/**
 * Turn state for one conversation, or for whichever turn is running.
 *
 * The unnamed form means "the running turn", which is what callers that
 * predate parallelism (evals, the turn log) actually want: in the single-turn
 * case they exercise there is exactly one.
 */
export function getSessionState(conversationId?: string): Readonly<TurnSessionState> {
  if (conversationId) return sessions.get(conversationId) ?? idleSession(conversationId);
  return liveSessions()[0] ?? idleSession(null);
}

/** Every turn in flight, ordered by conversation so the order is stable */
export function liveSessions(): TurnSessionState[] {
  return [...sessions.values()]
    .filter((s) => s.phase === "running")
    .sort((a, b) => (a.conversationId ?? "").localeCompare(b.conversationId ?? ""));
}

/**
 * Whether a turn is running — for one conversation, or for any of them.
 *
 * Both readings are needed and they answer different questions: "may I send in
 * this chat?" is per conversation, while "is anything working?" is app-wide.
 */
export function isTurnRunning(conversationId?: string): boolean {
  if (conversationId) return runningSession(conversationId) !== null;
  return liveSessions().length > 0;
}

/**
 * True when losing this page would lose real work: a page-local
 * stream dies with the document, and a tool phase's edits are not
 * replayed on resume. Host-mode streaming is reload-surviving, so
 * guarding it would fight the feature it exists to provide.
 */
export function isTurnUnrecoverable(conversationId?: string): boolean {
  const live = conversationId
    ? liveSessions().filter((s) => s.conversationId === conversationId)
    : liveSessions();
  return live.some((s) => s.inToolPhase || !s.source?.survivable);
}

// ── Injectable seams (tests) ────────────────────────────────

export interface EngineDeps {
  /** Chooses the transport for a turn */
  resolveSource: () => Promise<TurnSource>;
  /** Request preparation (context engine, routing, compaction) */
  prepare: (
    conversationId: string,
    opts?: {
      modelOverride?: string;
      /** The thinking rung (lib/effort-escalation.ts); dies with the turn */
      effortOverride?: ReasoningEffort;
    }
  ) => Promise<TurnPreparation>;
  /** Transport used when the survivable one refuses or dies */
  createFallbackSource: () => TurnSource;
  /** Renderer inactivity ceiling (transport silence → turn ends) */
  inactivityTimeoutMs: number;
  /**
   * Escalation policy (lib/escalation.ts): which model a stalled turn
   * continues on, if any. Injected so a test can drive a switch without a
   * populated model catalog, and so the policy stays in one leaf module.
   */
  pickEscalation: (
    fromModel: string,
    opts?: EscalationOptions
  ) => EscalationTargetChoice | null;
  /**
   * Rounds (model calls) allowed per batch of the tool loop. Defaults to
   * the harness bound (AGENT_ITERATIONS) — a test or eval can shorten it,
   * and nothing a user can set may.
   *
   * It was a settings slider, and a user who lowered it got an agent that
   * stopped mid-task: the exact complaint the loop is supposed to answer.
   */
  maxIterations?: number;
}

async function defaultResolveSource(): Promise<TurnSource> {
  try {
    if (await sessionHost.connect()) return new HostTurnSource(sessionHost);
  } catch {
    /* host unreachable — page-local below */
  }
  return new LocalTurnSource();
}

const defaultDeps: EngineDeps = {
  resolveSource: defaultResolveSource,
  prepare: prepareTurn,
  createFallbackSource: () => new LocalTurnSource(),
  inactivityTimeoutMs: TURN_INACTIVITY_TIMEOUT_MS,
  // Curated list as the last resort: a cold catalog (first run, before the
  // model list arrives) still escalates on evidence, just coarser evidence.
  pickEscalation: (fromModel, opts) =>
    pickEscalationTarget(fromModel, {
      catalog: getCachedModelCatalog() ?? CURATED_FALLBACK_MODELS,
      // The mid-turn switch happens because the model is stuck in a tool loop,
      // so the axis that matters is tool-loop competence.
      task: "agentic",
      competence: getCompetenceIndex(),
      ...opts,
    }),
};

// ── Helpers ─────────────────────────────────────────────────

let turnSeq = 0;

function createTurnId(): string {
  turnSeq += 1;
  return `turn_${Date.now().toString(36)}_${turnSeq.toString(36)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when this event belongs to `turnId` (watchdog bookkeeping) */
function isEventForTurn(event: HostEvent, turnId: string): boolean {
  switch (event.type) {
    case "DELTA":
      return event.delta.turnId === turnId;
    case "TOOL_CALLS":
      return event.payload.turnId === turnId;
    case "USAGE":
      return event.turnId === turnId;
    case "END":
      return event.payload.turnId === turnId;
    default:
      return false;
  }
}

function maxIterations(deps: EngineDeps): number {
  const configured = deps.maxIterations ?? AGENT_ITERATIONS;
  return Math.max(1, Math.round(configured) || AGENT_ITERATIONS);
}

/** Model attribution for the tool-phase transcript entry */
function toolPhaseMeta(conversationId: string): {
  content: string;
  reasoning: string;
  model: string;
} {
  const conv = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  const last = conv && conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : undefined;
  return { content: "", reasoning: "", model: last?.model ?? "" };
}

/**
 * Attaches the once-per-turn "you wrote calls as text" note to the
 * tool-calls transcript row, so the harness correction is visible to
 * the user AND to the model on its next round. Consumes the note, so a
 * later tool phase in the same turn is not annotated twice.
 */
function withRecoveryNote(
  conversationId: string,
  meta: { content: string; reasoning: string; model: string }
): {
  content: string;
  reasoning: string;
  model: string;
} {
  const session = sessionOf(conversationId);
  const note = session.recoveredNote;
  session.recoveredNote = null;
  if (!note) return meta;
  return { ...meta, content: [meta.content, note].filter(Boolean).join("\n\n") };
}

/** Runs tasks with bounded concurrency; results drain in submit order */
/**
 * Delivers messages the user sent while this turn was running.
 *
 * They are delivered at a ROUND BOUNDARY and nowhere else, for two reasons:
 * a round is the only point where the wire payload ends on a clean turn
 * boundary, and a message slipped in mid-round would sit in front of tool
 * results the model has not read yet — answering an instruction with
 * information it did not have when the instruction was written. Delivering
 * here also means the model reads it as the next user turn, which is exactly
 * what it would have been had the user waited for the reply.
 *
 * Returns how many were delivered. Exported because the send path calls it
 * too: a queued message is OLDER than whatever is being sent now, and a
 * transcript that shows them in the other order misrepresents the
 * conversation to the model reading it.
 */
export function deliverQueuedMessages(conversationId: string): number {
  const store = useChatStore.getState();
  let delivered = 0;
  for (;;) {
    const next = store.shiftQueuedMessage(conversationId);
    if (!next) break;
    store.addMessage(conversationId, {
      role: "user",
      content: next.text,
      ...(next.attachments && next.attachments.length > 0
        ? { attachments: next.attachments }
        : {}),
    });
    delivered += 1;
  }
  if (delivered > 0) {
    logTurnEvent({
      turnId: null,
      conversationId,
      phase: "resume",
      detail: `delivered ${delivered} message(s) queued while the turn ran`,
    });
  }
  return delivered;
}

async function runOrderedPool<T>(
  tasks: Array<{ run: () => Promise<T>; onSettled: (result: T) => void }>,
  limit: number,
  isAborted: () => boolean
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, tasks.length)) },
    async () => {
      while (next < tasks.length) {
        if (isAborted()) return;
        const task = tasks[next++]!;
        const result = await task.run();
        task.onSettled(result);
      }
    }
  );
  await Promise.all(workers);
}

// ── Rendering ───────────────────────────────────────────────

export type RenderOutcome =
  | {
      kind: "end";
      reason: HostEndReason;
      error?: string;
      modelId?: string;
      usage?: UsageInfo;
      content: string;
      reasoning: string;
      /** Structured reasoning blocks, replayed on the next tool round */
      reasoningDetails?: unknown[];
    }
  | {
      kind: "lost";
      content: string;
      reasoning: string;
      modelId?: string;
      usage?: UsageInfo;
      reasoningDetails?: unknown[];
    };

/**
 * Renders one transport turn into the store until END (or until the
 * transport goes silent past the inactivity ceiling, which is
 * reported as `lost` so the caller can fall back or explain).
 */
async function renderTurn(
  conversationId: string,
  source: TurnSource,
  turnId: string,
  seed: HostSnapshot | null | undefined,
  inactivityMs: number,
  /** Events captured between the start request and this subscription */
  prebuffer: HostEvent[] = []
): Promise<RenderOutcome> {
  // The turn this renderer belongs to. Reading it through the conversation id
  // (rather than from a module variable) is what lets two renderers run at
  // once: each folds its deltas into ITS OWN session and ITS OWN store buffer.
  const session = sessionOf(conversationId);
  const api = useChatStore.getState();
  if (!api.streams[conversationId]) api.beginStreaming(conversationId);

  let content = "";
  let reasoning = "";
  let modelId: string | undefined;
  let usage: UsageInfo | undefined;
  let endReason: HostEndReason | null = null;
  let endError: string | undefined;
  let reasoningDetails: unknown[] | undefined;
  let lost = false;

  // Snapshot replay: seed what the transport already produced before
  // this renderer attached (late attach / adoption).
  //
  // `snapshot.seq` is the seq of the LAST delta already folded into
  // that content, so it is also the watermark: any delta at or below
  // it is stale replay (captured in the prebuffer between the start
  // request and this subscription) and must be dropped, or the text
  // it carries lands in the transcript twice.
  let lastSeq = seed?.seq ?? 0;
  const seedContent = seed?.content ?? "";
  const seedReasoning = seed?.reasoning ?? "";
  if (seedContent) {
    useChatStore.getState().appendStreamingContent(conversationId, seedContent);
    content += seedContent;
  }
  if (seedReasoning) {
    useChatStore.getState().appendStreamingReasoning(conversationId, seedReasoning);
    reasoning += seedReasoning;
  }

  await new Promise<void>((resolve) => {
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let settled = false;

    const stopWatchdog = () => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    };
    const settle = (asLost: boolean) => {
      if (settled) return;
      settled = true;
      lost = asLost;
      stopWatchdog();
      unsubscribe?.();
      unsubscribe = null;
      resolve();
    };
    const bump = () => {
      if (settled) return;
      stopWatchdog();
      watchdog = setTimeout(() => settle(true), inactivityMs);
    };

    const handleEvent = (event: HostEvent) => {
      switch (event.type) {
        case "DELTA": {
          if (event.delta.turnId !== turnId) return;
          if (event.delta.seq > 0 && event.delta.seq <= lastSeq) return;
          lastSeq = Math.max(lastSeq, event.delta.seq);
          const c = event.delta.content ?? "";
          const r = event.delta.reasoning ?? "";
          content += c;
          reasoning += r;
          if (c) useChatStore.getState().appendStreamingContent(conversationId, c);
          if (r) useChatStore.getState().appendStreamingReasoning(conversationId, r);
          break;
        }
        case "TOOL_CALLS": {
          if (event.payload.turnId !== turnId) return;
          session.toolCalls = event.payload.calls as ToolCallRequest[];
          break;
        }
        case "USAGE": {
          if (event.turnId !== turnId) return;
          usage = event.usage;
          modelId = event.modelId;
          break;
        }
        case "END": {
          if (event.payload.turnId !== turnId) return;
          endReason = event.payload.reason;
          endError = event.payload.error;
          if (event.payload.usage) usage = event.payload.usage;
          if (event.payload.modelId) modelId = event.payload.modelId;
          if (event.payload.reasoningDetails) {
            reasoningDetails = event.payload.reasoningDetails;
          }
          settle(false);
          break;
        }
        default:
          break;
      }
    };

    unsubscribe = source.subscribe((event) => {
      if (isEventForTurn(event, turnId)) bump();
      handleEvent(event);
    });

    // Replay anything the transport emitted before this subscription
    // existed (the start request raced the first deltas).
    for (const event of prebuffer) {
      if (isEventForTurn(event, turnId)) bump();
      handleEvent(event);
    }

    bump();
  });

  if (lost) {
    return {
      kind: "lost",
      content,
      reasoning,
      modelId,
      usage,
      ...(reasoningDetails ? { reasoningDetails } : {}),
    };
  }
  return {
    kind: "end",
    reason: endReason ?? "failed",
    error: endError,
    modelId,
    usage,
    content,
    reasoning,
    ...(reasoningDetails ? { reasoningDetails } : {}),
  };
}

/** Commits the rendered turn per end reason; returns the message id */
function commitRender(
  conversationId: string,
  outcome: RenderOutcome,
  fallbackModelId?: string
): string | null {
  const session = sessionOf(conversationId);
  const api = useChatStore.getState();
  // The buffer is THIS conversation's, read at the moment of the commit: the
  // text a lost round produced is the text its own thread is holding, never
  // whatever another agent happens to be streaming alongside it.
  const streamed = api.streams[conversationId]?.content ?? "";
  const streamedReasoning = api.streams[conversationId]?.reasoning ?? "";
  // The model id IS the wire model now — no virtual-model masking.
  const model = outcome.modelId ?? fallbackModelId ?? undefined;
  const reasoning = (streamedReasoning || outcome.reasoning) || undefined;
  const meta = {
    effort: session.effort,
    mode: session.mode,
    // Reasoning blocks ride every commit path, including the aborted and
    // tool-calls ones. A tool round is exactly the case that needs them: the
    // next request replays the assistant message that requested the tools, and
    // providers that interleave thinking with tool calls reject that round if
    // its reasoning is missing.
    ...(outcome.reasoningDetails && outcome.reasoningDetails.length > 0
      ? { reasoningDetails: outcome.reasoningDetails }
      : {}),
  };

  if (outcome.kind === "lost") {
    api.discardStreaming(conversationId);
    if (streamed.trim()) {
      return api.commitDirectAssistantMessage(conversationId, {
        content: `${streamed}\n\n— _the response engine stopped responding; partial reply kept._`,
        reasoning,
        model,
        ...meta,
      });
    }
    return api.commitDirectAssistantMessage(conversationId, {
      content: "Lost connection to the response engine. Send again to retry.",
      model,
      error: true,
    });
  }

  switch (outcome.reason) {
    case "done":
    case "tool-calls": {
      return api.commitDirectAssistantMessage(conversationId, {
        content: streamed || outcome.content,
        reasoning,
        model,
        ...meta,
        usage: outcome.usage,
      });
    }
    case "aborted": {
      return api.commitDirectAssistantMessage(conversationId, {
        content: streamed || outcome.content,
        reasoning,
        model,
        ...meta,
        usage: outcome.usage,
        error: !(streamed || outcome.content).trim() ? true : undefined,
      });
    }
    default: {
      // failed | exhausted | reroute-needed: keep any partial text and
      // explain the cut; with nothing streamed, surface the reason.
      const text = (streamed || outcome.content).trim();
      if (text) {
        return api.commitDirectAssistantMessage(conversationId, {
          content: `${text}\n\n— _${outcome.error ?? "the response could not be completed."}_`,
          reasoning,
          model,
          ...meta,
          usage: outcome.usage,
        });
      }
      return api.commitDirectAssistantMessage(conversationId, {
        content:
          outcome.error ??
          `${model ? modelDisplayName(model) : "The model"} could not complete this response. Try again shortly.`,
        model,
        ...meta,
        error: true,
      });
    }
  }
}

// ── Agent tools (page-side execution between rounds) ────────

/**
 * Plan-mode hard guard, shared by every executor path.
 *
 * Plan mode never RECEIVES the mutating tool definitions, so a call for one
 * is either a hallucination or a stale transcript echoing an old Build turn
 * — refuse it here as well, because a model visibly trying to edit is
 * exactly the failure mode Plan mode exists to prevent. `http_write` is the
 * app tool this catches today: it is withheld from a plan turn, and this is
 * what stops a plan turn from sending it anyway.
 */
function planModeRefusal(conversationId: string, name: ToolName): ToolCallResult | null {
  if (isPlanSafeTool(name)) return null;
  const conversation = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (resolveModelState(conversation).mode !== "plan") return null;
  return {
    callId: "",
    name,
    ok: false,
    data: {
      error:
        `Tool "${name}" is unavailable in Plan mode. Analyze and propose a plan instead; ` +
        `the user must switch to Build mode before anything outside this conversation can change.`,
    },
    durationMs: 0,
    summary: "blocked in plan mode",
  };
}

/** Routes coding-agent bridge tools (write/ship/verify) to executors */
async function runBridgeTool(
  conversationId: string,
  name: ToolName,
  args: Record<string, unknown>,
  opts: { callId?: string; signal?: AbortSignal } = {}
): Promise<ToolCallResult> {
  const { signal } = opts;
  const refused = planModeRefusal(conversationId, name);
  if (refused) return refused;

  switch (name) {
    case "write_file":
      return runWriteFile(conversationId, args);
    case "edit_file":
      return runEditFile(conversationId, args);
    case "delete_file":
      return runDeleteFile(conversationId, args);
    case "search_workspace":
      return runSearchWorkspace(conversationId, args);
    case "get_workspace_diff":
      return runWorkspaceDiff(conversationId, args);
    case "remember":
      return runRemember(conversationId, args);
    case "delegate":
      return runDelegate(conversationId, args);
    case "create_working_branch":
      return runCreateWorkingBranch(conversationId, args);
    case "push_changes":
      return runPushChanges(conversationId, args, signal);
    case "run_checks":
      return runRunChecks(conversationId, args);
    // Runtime evidence. The preview is observed, never started or stopped
    // from here — the harness owns its lifecycle (preview-bridge.ts) — and a
    // background process is refused before it starts if it names a dev
    // script, because the dev server is the preview.
    case "read_preview":
      return runReadPreview(conversationId, args);
    case "wait_for_preview":
      return runWaitForPreview(conversationId, args, signal);
    case "run_process":
      return runStartProcess(conversationId, args);
    case "read_process":
      return runReadProcess(conversationId, args);
    case "stop_process":
      return runStopProcess(conversationId, args);
    // The preview interaction pair follows the same authority line as
    // run_command: snapshot is a read (plan-safe), while driving or
    // evaluating inside the page runs with the app's own authority and is
    // withheld from plan mode by the same gate that withholds the writes.
    case "preview_snapshot":
      return runPreviewSnapshot(conversationId, args);
    case "preview_interact":
      return runPreviewInteract(conversationId, args, signal);
    case "preview_evaluate":
      return runPreviewEvaluate(conversationId, args);
    case "update_plan":
      return runUpdatePlan(conversationId, args);
    case "list_mcp_tools":
      return runListMcpTools(conversationId, args);
    case "call_mcp_tool":
      return runCallMcpTool(conversationId, args, signal);
    case "run_command":
      return runShellCommand(conversationId, args, signal);
    case "verify_with_ci":
      return runCiVerification(conversationId, args, signal);
    // GitHub collaboration. The reads are plain bridge calls; the four writes
    // reach the user through the same approval gate `http_write` uses, and the
    // gate lives in the executor so every caller (the engine, an eval) is
    // gated by construction rather than by remembering to ask.
    case "list_issues":
      return runListIssues(conversationId, args);
    case "read_issue":
      return runReadIssue(conversationId, args);
    case "list_pull_requests":
      return runListPullRequests(conversationId, args);
    case "read_pull_request":
      return runReadPullRequest(conversationId, args);
    case "read_ci_logs":
      return runReadCiLogs(conversationId, args);
    case "create_issue":
      return runCreateIssue(conversationId, args);
    case "comment_on_issue":
      return runCommentOnIssue(conversationId, args);
    case "review_pull_request":
      return runReviewPullRequest(conversationId, args);
    case "update_pull_request":
      return runUpdatePullRequest(conversationId, args);
    // The two harness-interaction tools. `ask_user` parks this call until
    // the user answers (it needs the call id to pair the answer with its
    // request); `suggest_next` publishes chips and returns immediately.
    case "ask_user":
      return runAskUser(conversationId, args, { callId: opts.callId ?? "", signal });
    case "suggest_next":
      return runSuggestNext(conversationId, args);
    default: {
      // Registry-consistency guard: a tool marked kind:"bridge" must
      // have a case here.
      const meta = getToolMeta(name);
      return {
        callId: "",
        name,
        ok: false,
        data: {
          error:
            meta?.kind === "bridge"
              ? `Bridge tool "${name}" has no executor wired (registry/dispatcher mismatch).`
              : `Unknown agent tool: ${name}`,
        },
        durationMs: 0,
      };
    }
  }
}

/**
 * Executes agent tool calls in the page and commits their results in
 * request order (deterministic transcript even with parallel reads).
 */
async function executeToolPhase(
  conversationId: string,
  calls: ToolCallRequest[],
  streamMeta: { content: string; reasoning: string; model: string }
): Promise<void> {
  const session = sessionOf(conversationId);
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const repoContext = conversation?.repoContext;
  const settings = store.settings;
  // One view for the whole phase: this thread's working copy, at the revision
  // the phase is reading through. It is what keeps the shared tool cache from
  // handing THIS agent a peer's uncommitted edit as "the file's content".
  const readView = readViewFor(conversationId);

  useChatStore.getState().commitToolCallsMessage(conversationId, calls, streamMeta);

  const results = new Map<number, ToolCallResult>();
  let drainFrom = 0;
  const drainOrdered = () => {
    while (results.has(drainFrom)) {
      const result = results.get(drainFrom)!;
      results.delete(drainFrom);
      useChatStore
        .getState()
        .commitToolResult(conversationId, result, serializeToolResult(result));
      drainFrom++;
    }
  };

  interface PendingTool {
    idx: number;
    /** The call as it will EXECUTE (arguments possibly repaired) */
    call: ToolCallRequest;
    cacheKey: string | null;
    /** Set when the arguments were coerced, so the row says so */
    argNote?: string;
  }

  /**
   * Records one execution outcome against the turn ledger. Every path
   * that produces a result reports here — including cached hits and
   * argument failures — so the repetition policy sees the whole truth
   * rather than only the calls that reached the network.
   */
  const record = (call: ToolCallRequest, result: ToolCallResult): ToolCallResult => {
    const signature = callSignature(call.name, call.arguments);
    const prior = session.callLedger.get(signature);
    // A failure the ledger has already seen once comes back with its tool's own
    // contract attached (lib/tool-surface.ts): the first identical error is a
    // fact, the second is evidence that the fact was not enough.
    const repeated = (prior?.count ?? 0) >= 1;
    const enriched = repeated && !result.ok ? withContractHint(result) : result;
    session.callLedger.set(signature, {
      count: (prior?.count ?? 0) + 1,
      ok: result.ok,
      digest: enriched.summary ?? (result.ok ? "ok" : "failed"),
      resultText: serializeToolResult(enriched).slice(0, LEDGER_RESULT_MAX_CHARS),
    });
    return enriched;
  };

  const pending: PendingTool[] = [];
  calls.forEach((call, idx) => {
    // ── Repetition policy (loop breaking) ──
    // Runs BEFORE anything else: a repeated call must not be
    // re-validated, re-cached or re-sent to the network.
    const signature = callSignature(call.name, call.arguments);
    const decision = repeatDecision(session.callLedger.get(signature), REPEAT_MAX_EXECUTIONS);
    if (decision.action !== "execute") {
      const reuse = decision.action === "reuse";
      results.set(idx, {
        callId: call.id,
        name: call.name,
        ok: reuse,
        data: {
          note: reuse ? "identical call already ran this turn" : "repeated failing call refused",
          message: reuse
            ? reuseResultText(decision.entry)
            : refuseResultText(decision.entry, call.name),
        },
        durationMs: 0,
        summary: reuse ? "reused earlier result" : "repeated failing call refused",
      });
      if (!reuse) session.stuckRefusals += 1;
      logTurnEvent({
        turnId: session.turnId,
        conversationId,
        phase: "tool-phase",
        detail: `${call.name}: ${reuse ? "reused from ledger" : "refused (repeated failure)"}`,
      });
      return;
    }

    // ── Surface enforcement ──
    // The model may only call what this round OFFERED it. Checked here, right
    // after the repetition policy and before anything is parsed or executed, so
    // a tool the profile withheld cannot be reached by hallucinating its name.
    if (session.sentToolNames && session.sentToolNames.size > 0) {
      const refusal = withheldRefusal(call.name, session.sentToolNames);
      if (refusal) {
        const blocked: ToolCallResult = {
          callId: call.id,
          name: call.name,
          ok: false,
          data: { error: refusal },
          durationMs: 0,
          summary: "tool not offered this turn",
        };
        results.set(idx, record(call, blocked));
        session.stuckRefusals += 1;
        logTurnEvent({
          turnId: session.turnId,
          conversationId,
          phase: "tool-phase",
          detail: `${call.name}: refused (not in this turn's tool surface)`,
        });
        return;
      }
    }

    // ── Argument repair ──
    // Repair first, validate second: a fence or a trailing comma should
    // cost this turn nothing, and the repaired text is what executes.
    const repaired = repairToolArguments(call.arguments);
    const argsText = repaired.args ? JSON.stringify(repaired.args) : call.arguments;
    if (repaired.repaired) {
      logTurnEvent({
        turnId: session.turnId,
        conversationId,
        phase: "tool-phase",
        detail: `${call.name}: arguments repaired (${repaired.note ?? "normalized"})`,
      });
    }
    const normalized: ToolCallRequest = argsText === call.arguments ? call : { ...call, arguments: argsText };

    const validation = validateToolCall(normalized.name, normalized.arguments);
    // Coercion notes are the harness having fixed the model's call; the model is
    // told, because a silent repair teaches it that the shape was acceptable.
    const argNote = validation.ok ? argumentRepairNote(validation.notes) : "";
    if (argNote) {
      logTurnEvent({
        turnId: session.turnId,
        conversationId,
        phase: "tool-phase",
        detail: `${call.name}: ${argNote}`,
      });
    }
    if (!validation.ok) {
      const failure: ToolCallResult = {
        callId: call.id,
        name: call.name,
        ok: false,
        data: { error: validation.error },
        durationMs: 0,
        summary: "invalid arguments",
      };
      results.set(idx, record(normalized, failure));
      return;
    }
    const cacheKey = repoContext ? toolCacheKey(normalized, repoContext, readView) : null;
    const hit = lookupToolCache(cacheKey);
    if (hit) {
      const cached: ToolCallResult = { ...hit, callId: call.id, durationMs: 0 };
      results.set(idx, record(normalized, cached));
    } else {
      pending.push({ idx, call: normalized, cacheKey, ...(argNote ? { argNote } : {}) });
    }
  });
  drainOrdered();

  if (pending.length > 0) {
    const kindOf = (p: PendingTool) => getToolMeta(p.call.name)?.kind;
    const settle = (p: PendingTool) => (result: ToolCallResult) => {
      const noted = p.argNote
        ? { ...result, summary: result.summary ? `${result.summary} · args repaired` : "args repaired" }
        : result;
      results.set(p.idx, record(p.call, noted));
      drainOrdered();
    };

    /**
     * A repo tool called with no repository attached.
     *
     * The surface is not built to offer one (turn-prep filters a repo-free
     * turn down to `isRepoFreeTool`), so reaching this is a stale transcript
     * or a hallucinated call. It gets a precise answer rather than the
     * generic unknown-tool text, because the fix is attach a repo — and a
     * model told WHY can say so instead of retrying.
     */
    const needsRepo = (p: PendingTool): ToolCallResult => ({
      callId: p.call.id,
      name: p.call.name,
      ok: false,
      data: {
        error:
          `"${p.call.name}" needs an attached repository, and this conversation has none. ` +
          "Attach one with the repo picker in the chat header, or use the tools that work " +
          "without a checkout (run_code, format_code, compare_data, diff_text, search_library, " +
          "search_web, fetch_url).",
      },
      durationMs: 0,
      summary: "no repository attached",
    });

    // ── Sequential pass: app tools AND repo bridge tools, in submission order ──
    //
    // Two kinds execute one at a time and are therefore handled in ONE pass,
    // because the order between them is meaningful: "write the file, then run
    // the snippet" only means what it says if the write lands first.
    //
    //   • a bridge tool is a read-modify-write on the same workspace
    //     snapshot, so running them concurrently made the last write win and
    //     silently discard its siblings' files;
    //   • an app tool owns a shared resource — the compiler service holds ONE
    //     active worker per engine (a second run_code would clobber the
    //     first) and http_write blocks the turn on a user's decision.
    //
    // The abort signal goes INTO the tool, not just between tools. The check
    // above only fires once the previous tool has returned, and `run_command`
    // may hold the turn for ten minutes, `verify_with_ci` for fifteen and
    // run_code for a minute, so without it Stop was a button that did nothing
    // visible during exactly the waits a user wants to end.
    const sequential = pending.filter((p) => {
      const kind = kindOf(p);
      return kind === "app" || kind === "bridge";
    });
    for (const p of sequential) {
      const kind = kindOf(p);
      // A bridge tool normally needs a working copy to read or write. The
      // ones the registry flags `repoFree` do not — asking the user a
      // question is the clearest case, and it is most needed precisely in a
      // chat where no repository was ever attached.
      if (kind === "bridge" && !repoContext && !isRepoFreeTool(p.call.name)) {
        settle(p)(needsRepo(p));
        continue;
      }
      const signal = session.abort?.signal;
      if (signal?.aborted) return;
      const args = parseToolArguments(p.call.arguments);
      const result =
        kind === "app"
          ? await runAppTool(conversationId, p.call.name, args, signal)
          : await runBridgeTool(conversationId, p.call.name, args, {
              callId: p.call.id,
              signal,
            });
      settle(p)({ ...result, callId: p.call.id });
      // A tool that ended because the user stopped it must not be followed
      // by the next one in the same round: continuing to execute a list of
      // commands after Stop is the opposite of what was asked for.
      if (signal?.aborted) return;
    }

    // ── Reads (and batched read programs) then fan out ──
    // Independent and network-bound, so they run with bounded concurrency.
    // A repo-free conversation keeps the few read tools flagged `repoFree`
    // (the web pair and the skill loader); the rest — all reads OF a
    // repository — are answered with the precise reason instead of being
    // dropped silently.
    const readTools = pending.filter((p) => {
      const kind = kindOf(p);
      return kind !== "app" && kind !== "bridge";
    });
    const runnableReads = repoContext
      ? readTools
      : readTools.filter((p) => isRepoFreeTool(p.call.name));
    for (const p of readTools) {
      if (!runnableReads.includes(p)) settle(p)(needsRepo(p));
    }
    if (runnableReads.length > 0) {
      // The repo-free read tools never touch these fields (the web pair and
      // read_skill take no repo), so an empty stand-in is honest here rather
      // than a lie: nothing downstream can read it.
      const repoForReads = repoContext ?? EMPTY_REPO_CONTEXT;
      await runOrderedPool(
        runnableReads.map((p) => ({
          run: () =>
            executeToolCall(p.call, {
              token: settings.github.token,
              repo: repoForReads,
              signal: session.abort?.signal,
              conversationId,
            }).then((result) => {
              storeToolCache(p.cacheKey, result);
              return result;
            }),
          onSettled: settle(p),
        })),
        TOOL_EXECUTION_CONCURRENCY,
        () => session.abort?.signal.aborted ?? false
      );
    }
  }
}

/**
 * Assesses how hard this turn is working, from state the executor and the
 * ledger already maintain. Pure aggregation — every input is a count this
 * module produced, so the assessment is an honest read of the turn rather
 * than a new heuristic.
 *
 * The one deliberate shortcut: per-signature counts come from the call
 * ledger, and the alternation shape is re-derived from those counts (each
 * signature repeated by its count, bounded) rather than by keeping a new
 * per-call execution record. The ledger is already the turn's whole memory
 * of what ran; a second ledger would be a second thing to forget to clear.
 */
function assessDifficultyFor(conversationId: string): DifficultyAssessment {
  const session = sessionOf(conversationId);
  const state = useChatStore.getState();
  const workspace = selectWorkspace(state, conversationId);
  const revision = workspace?.updatedAt ?? -1;

  let mostRepeated = 0;
  let failed = 0;
  const orderProxy: string[] = [];
  for (const [signature, entry] of session.callLedger) {
    orderProxy.push(...Array(Math.min(entry.count, 6)).fill(signature));
    if (entry.count > mostRepeated) mostRepeated = entry.count;
    if (!entry.ok) failed += 1;
  }

  return assessDifficulty({
    failedCalls: failed,
    mostRepeatedCall: mostRepeated,
    alternatingPairs: countAlternationCycles(orderProxy),
    stuckRefusals: session.stuckRefusals,
    argumentRepairs: countArgumentRepairs(conversationId),
    continuations: continuationCount(conversationId),
    completionNudges: completionNudgeCount(conversationId),
    freshFailingChecks: verificationEvidence(conversationId, {
      workspaceUpdatedAt: revision,
    }).filter((e) => e.status === "fresh-fail").length,
    freshPreviewErrors:
      previewOwnerThreadId() === conversationId && livePreviewState().status === "running"
        ? livePreviewState().issues.filter(
            (i) => i.at >= revision && (i.kind === "uncaught" || i.kind === "unhandled-rejection")
          ).length
        : 0,
  });
}

/**
 * Round-outcome counters. The engine already logs every one of these as
 * turn-log events with stable phrasings, so the counters re-derive them
 * from the log rather than adding a second bookkeeping path — one source
 * of truth for "what happened this turn".
 */
function countArgumentRepairs(conversationId: string): number {
  return getTurnLog().filter(
    (e) =>
      e.conversationId === conversationId &&
      e.phase === "tool-phase" &&
      typeof e.detail === "string" &&
      e.detail.includes("arguments repaired")
  ).length;
}

function completionNudgeCount(conversationId: string): number {
  return getTurnLog().filter(
    (e) =>
      e.conversationId === conversationId &&
      e.phase === "completion-gate" &&
      typeof e.detail === "string" &&
      e.detail.startsWith("unfinished — ")
  ).length;
}

function continuationCount(conversationId: string): number {
  return getTurnLog().filter(
    (e) =>
      e.conversationId === conversationId &&
      e.phase === "resume" &&
      typeof e.detail === "string" &&
      e.detail.startsWith("tool-use checkpoint hit")
  ).length;
}

/**
 * The ladder's thinking rung: raises the reasoning effort on the SAME
 * model when the turn is struggling, before any model swap.
 *
 * Same consent model as `maybeEscalate` — the change is announced in the
 * transcript with its named basis, it affects only the rest of this turn,
 * and it dies with the turn. Skipped entirely when adaptive effort is off
 * in settings (default on) or the turn already spent its bump.
 */
function maybeBumpEffort(
  conversationId: string,
  conversation: ChatConversation | undefined,
  deps: EngineDeps
): EffortBumpChoice | null {
  void deps;
  const session = sessionOf(conversationId);
  const store = useChatStore.getState();
  const difficulty = session.difficulty;
  if (!difficulty) return null;

  const current = resolveModelState(conversation).effort;
  const fromModel = session.modelOverride ?? conversation?.model ?? store.settings.defaultModel;
  const choice = pickEffortBump(current, difficulty, {
    enabled: store.settings.adaptiveEffort !== false,
    alreadyBumped: session.effortBumped,
    alreadyEscalated: session.escalated,
    modelInfo: resolveModelInfo(fromModel),
  });
  if (!choice) return null;

  session.effortBumped = true;
  session.effortOverride = choice.effort;
  logTurnEvent({
    turnId: session.turnId,
    conversationId,
    phase: "failover",
    detail: effortBumpLogDetail(choice),
  });
  // Visible, and in the transcript the next round is built from — the same
  // channel a model swap uses, because for the model reading it this is the
  // same kind of fact: the harness changed a parameter of the request.
  store.addMessage(conversationId, {
    role: "assistant",
    content: effortEscalationNote(choice),
  });
  return choice;
}

/**
 * Spends this turn's single escalation: pick a stronger model, announce
 * the switch, and point the rest of the turn at it.
 *
 * Deliberately narrow. It fires only when the model has already been told
 * in words that a call fails and repeated it anyway, it fires at most once
 * per turn, and it says nothing when the catalog offers no model known to
 * be stronger — an honest failure is worth more than a lateral swap that
 * looks like a retry.
 *
 * The conversation's own model is untouched: the override dies with the
 * turn, so the next message goes back to the model the user picked.
 */
function maybeEscalate(conversationId: string, fromModel: string, deps: EngineDeps): void {
  const session = sessionOf(conversationId);
  const store = useChatStore.getState();
  if (!canEscalate({ enabled: store.settings.autoEscalate, alreadyEscalated: session.escalated })) {
    return;
  }
  // The model that got stuck is the one this turn is running on — which
  // may already be an escalated model, in which case nothing else to try.
  const from = session.modelOverride ?? fromModel;
  // No `preferred`: the target is the harness's pick (the cheapest model
  // the catalog knows to be stronger). A user-set model id here was a
  // question they could not answer — what they need is the consent that
  // `autoEscalate` gives, not a vote on which model the catalog rates above
  // the one that just stalled.
  const choice = deps.pickEscalation(from, {
    enabled: store.settings.autoEscalate,
    needTools: true,
  });
  session.escalated = true;
  if (!choice) {
    logTurnEvent({
      turnId: session.turnId,
      conversationId,
      phase: "failover",
      detail: `stalled on ${from}; ${noEscalationReason(null, { enabled: store.settings.autoEscalate })}`,
    });
    return;
  }

  session.modelOverride = choice.modelId;
  logTurnEvent({
    turnId: session.turnId,
    conversationId,
    phase: "failover",
    modelId: choice.modelId,
    detail: `stalled on ${from} → ${choice.modelId} (${choice.reason})`,
  });
  // Visible, and in the transcript the next round is built from: the model
  // reading it knows the harness changed its mind about who is answering.
  store.addMessage(conversationId, {
    role: "assistant",
    content: escalationNote(choice, modelDisplayName(from)),
  });
}

// ── Rounds ──────────────────────────────────────────────────

interface RoundResult {
  kind: "done" | "tools" | "exhausted" | "lost" | "busy";
  /** True when the round produced something the user can see */
  committed: boolean;
  /** Present on a lost round, so the loss can be explained if it sticks */
  outcome?: RenderOutcome;
  /**
   * True when this round ran WITH the agent's write tools, which is the
   * completion gate's precondition: a reply that could not edit anything
   * cannot have left an edit half-finished.
   */
  agentTools?: boolean;
}

async function runRound(
  conversationId: string,
  source: TurnSource,
  deps: EngineDeps
): Promise<RoundResult> {
  const session = sessionOf(conversationId);
  const prepared = await deps.prepare(conversationId, {
    modelOverride: session.modelOverride ?? undefined,
    // The thinking rung: an effort bump dies with the turn, like the
    // model override beside it.
    effortOverride: session.effortOverride ?? undefined,
  });
  if (prepared === null) return { kind: "done", committed: false };

  const turn: PreparedTurn = prepared;
  const turnId = createTurnId();
  // Read-only rounds (chat mode, plan mode) can never leave work open, so
  // the gate is told what the round actually carried. Compiled from the
  // same tools the model was sent — never from what it claims it did.
  const agentTools =
    turn.mode === "build" && Array.isArray(turn.tools) && turn.tools.length > 0;
  // The surface this round OFFERED, which is what the executor enforces
  // (TurnSessionState.sentToolNames). Written per round because the surface is
  // recomputed per round: a lean-profile model, a plan turn and a repo-free
  // chat each get a different list, and a call is legal only against the list it
  // was actually sent alongside.
  session.sentToolNames = new Set(
    (Array.isArray(turn.tools) ? turn.tools : [])
      .map((t) => (t as { function?: { name?: string } }).function?.name ?? "")
      .filter(Boolean)
  );
  session.turnId = turnId;
  // Recorded on every committed message so the transcript shows the
  // state a reply was produced under.
  session.effort = turn.effort;
  session.mode = turn.mode;

  const payload: HostStartTurnPayload = {
    turnId,
    conversationId,
    apiKey: useChatStore.getState().settings.apiKey.trim(),
    systemPrompt: turn.systemPrompt,
    temperature: turn.temperature,
    messages: turn.messages,
    tools: turn.tools,
    candidates: turn.candidates,
  };

  logTurnEvent({
    turnId,
    conversationId,
    phase: "turn-start",
    detail: `${source.label} transport · ${turn.modelId} · ${turn.mode} · effort=${turn.effort}`,
  });

  // Subscribe BEFORE starting: the first deltas can race the start
  // acknowledgement, and a turn whose opening text vanishes is worse
  // than one that never began.
  const prebuffer: HostEvent[] = [];
  let buffering = true;
  const unsubscribePrebuffer = source.subscribe((event) => {
    if (buffering) prebuffer.push(event);
  });
  let started: StartOutcome;
  try {
    started = await source.startTurn(payload);
  } finally {
    buffering = false;
    unsubscribePrebuffer();
  }
  if (started.kind === "busy") return { kind: "busy", committed: false };
  if (started.kind === "unavailable") return { kind: "lost", committed: false };

  const outcome = await renderTurn(
    conversationId,
    source,
    turnId,
    started.snapshot,
    deps.inactivityTimeoutMs,
    prebuffer
  );

  // ── Text-emitted tool calls (weak-model recovery) ──────────
  // The most expensive failure a cheap model makes is describing a call
  // in prose instead of emitting one: the turn ends looking finished
  // while nothing happened. Recover the calls from its own text ONCE
  // per turn and run them exactly like real ones. Guarded three ways:
  // the model must have been sent tools at all, every recovered name
  // must be a real registry tool, and the recovery happens once.
  if (
    outcome.kind === "end" &&
    outcome.reason === "done" &&
    !session.recoveredTextCalls &&
    Array.isArray(turn.tools) &&
    turn.tools.length > 0
  ) {
    const known = new Set(
      turn.tools
        .map((t) => (t as { function?: { name?: unknown } }).function?.name)
        .filter((n): n is string => typeof n === "string")
    );
    const found = extractTextToolCalls(outcome.content || outcome.reasoning, known).filter((c) =>
      isValidToolName(c.name)
    );
    if (found.length > 0) {
      session.recoveredTextCalls = true;
      session.toolCalls = recoveredToolCalls(found);
      session.recoveredNote = noToolCallNudge(found.map((c) => c.name));
      outcome.reason = "tool-calls";
      logTurnEvent({
        turnId,
        conversationId,
        phase: "tool-phase",
        detail: `recovered ${found.length} tool call(s) written as text: ${found.map((c) => c.name).join(", ")}`,
      });
    }
  }

  // Token calibration for the exact payload we sent. The estimate
  // must use the same accounting the context meter shows (one shared
  // tool-schema estimator), otherwise the learned ratio absorbs the
  // difference and quietly skews every budget.
  if (outcome.usage?.promptTokens != null) {
    const assigned = outcome.modelId ?? turn.modelId;
    const toolSchemaTokens = estimateToolSchemaTokens(
      turn.tools as ToolDefinition[] | undefined,
      assigned
    );
    const estimated =
      estimateTokens(turn.systemPrompt, assigned) + turn.sentTokens + toolSchemaTokens;
    recordUsageCalibration(assigned, estimated, outcome.usage.promptTokens);
  }

  // A lost round that produced nothing is NOT "committed": the caller
  // gets one retry on another transport, and only explains the loss
  // when a retry is impossible. Committing an error row here made the
  // fallback unreachable — it turned the promised retry into a dead
  // branch that told the user to resend instead.
  const produced =
    Boolean(outcome.content.trim() || outcome.reasoning.trim()) || session.toolCalls.length > 0;
  if (outcome.kind === "lost" && !produced) {
    useChatStore.getState().discardStreaming(conversationId);
    useChatStore.getState().endStreaming(conversationId, false);
    session.turnId = null;
    return { kind: "lost", committed: false, outcome };
  }

  const committedId = commitRender(conversationId, outcome, turn.modelId);
  useChatStore
    .getState()
    .endStreaming(conversationId, outcome.kind === "end" && outcome.reason === "aborted");
  session.turnId = null;

  if (outcome.kind === "lost") {
    return { kind: "lost", committed: Boolean(committedId), outcome };
  }
  logTurnEvent({
    turnId,
    conversationId,
    phase: "stream-end",
    modelId: outcome.modelId,
    detail: `${source.label} round ${outcome.reason}`,
  });

  if (outcome.reason === "tool-calls") {
    return { kind: "tools", committed: Boolean(committedId) };
  }
  if (outcome.reason === "done" || outcome.reason === "aborted") {
    return { kind: "done", committed: Boolean(committedId), agentTools };
  }
  return { kind: "exhausted", committed: Boolean(committedId) };
}

/**
 * Transport + fallback bookkeeping that outlives one batch of rounds.
 * The transport can be swapped mid-turn (survivable host → page-local),
 * and the swap must be remembered across a continuation, not re-tried.
 */
interface RoundRunner {
  source: TurnSource;
  localFallbacks: number;
  /** Rounds that died with nothing rendered and were retried in place */
  lostRetries: number;
  /**
   * Completion continuations spent this turn (lib/completion-gate.ts).
   * Lives on the runner, not the batch, because it is a property of the
   * TURN: five batches must not each get their own allowance.
   */
  completionNudges: number;
}

/**
 * Reads the two sources that can contradict a stop — the agent's own plan
 * and the evidence recorded against the revision in the workspace — and
 * decides whether the turn is really over.
 *
 * Read here rather than threaded through the engine so that a conversation
 * with no workspace attached simply has no evidence to answer with, and so
 * that the gate always sees the CURRENT revision instead of the one that
 * existed when the round started.
 */
function completionVerdictFor(conversationId: string, agentTools: boolean): CompletionVerdict {
  const session = sessionOf(conversationId);
  const state = useChatStore.getState();
  const conversation = state.conversations.find((c) => c.id === conversationId);
  const workspace = selectWorkspace(state, conversationId);
  // The change set and "does this project have tests" are read HERE, at the
  // stop, rather than threaded through the loop: both are properties of the
  // workspace as it stands now, and a value captured when the round started
  // would describe code the agent has since replaced.
  const changeSet = workspace
    ? collectChanges(workspace).map((c) => ({ path: c.path, status: c.status }))
    : undefined;
  return evaluateCompletion({
    plan: conversation?.plan,
    evidence: verificationEvidence(conversationId, {
      // No workspace means no revision any evidence could describe: -1 can
      // never equal a recorded revision, so nothing reads as fresh.
      workspaceUpdatedAt: workspace?.updatedAt ?? -1,
    }),
    changeSet,
    // The preview's verdict on the code as it stands now, read at the stop like
    // the change set above: a value captured when the round started would
    // describe an app the agent has since replaced. The preview's own issues
    // are timestamped, so the gate compares them against THIS revision and a
    // pre-edit exception can never gate a turn that replaced that code.
    //
    // Scoped to THIS conversation: the preview state is page-global (one dev
    // server per page), so a gate that read it unscoped would nudge a turn
    // for exceptions thrown by ANOTHER thread's app. Only the thread that
    // owns the running preview contributes its evidence.
    preview:
      previewOwnerThreadId() === conversationId && livePreviewState().status !== "idle"
        ? {
            // The LIVE session, not the viewed record: the user may be reading
            // another repo's archived failure while THIS thread's server runs,
            // and the gate asks about the app this thread's edits feed.
            status: livePreviewState().status,
            workspaceUpdatedAt: workspace?.updatedAt ?? -1,
            issues: livePreviewState().issues,
          }
        : undefined,
    projectHasTests: workspace ? workspace.tree.some((e) => isTestPath(e.path)) : undefined,
    agentTools,
    // The stop is the user's, not the model's — a stop always wins.
    aborted: Boolean(session.abort?.signal.aborted),
    // A turn parked on a question is waiting, not finished — and it is
    // certainly not unfinished work to be nudged about.
    pendingQuestion: Boolean(conversation?.pendingQuestion),
  });
}

/**
 * Runs up to `cap` rounds (stream → tools → stream).
 *
 * Returns true when the turn is genuinely over: the model stopped
 * talking, the transport died with nothing to retry on, or the user
 * aborted. Returns false only when the batch ran out of iterations
 * while the agent was still calling tools — i.e. the work is unfinished,
 * not finished.
 */
async function runBatch(
  conversationId: string,
  deps: EngineDeps,
  runner: RoundRunner,
  cap: number
): Promise<boolean> {
  const session = sessionOf(conversationId);
  // `completionNudges` extends the bound as it is granted: a nudge only
  // ever follows a round the model ended itself, so a runaway TOOL loop
  // still stops at exactly `cap`, while stopping with the work open buys
  // the round it needs to finish it.
  for (let iteration = 0; iteration < cap + runner.completionNudges; iteration++) {
    if (session.abort?.signal.aborted) return true;

    // Anything the user typed while the previous round ran becomes part of
    // the conversation HERE, at the boundary between two rounds.
    deliverQueuedMessages(conversationId);

    const result = await runRound(conversationId, runner.source, deps);

    // Transport refused (another conversation owns the host) or went
    // silent. A round that already produced something is never retried —
    // that would duplicate visible output — so it ends the turn here.
    if (result.kind === "busy" || result.kind === "lost") {
      if (result.committed) return true;

      // 1. A dead survivable transport is never going to answer: move
      //    the rest of the turn to the page-local one.
      if (runner.source.survivable && runner.localFallbacks === 0) {
        runner.localFallbacks += 1;
        useChatStore.getState().discardStreaming(conversationId);
        logTurnEvent({
          turnId: null,
          conversationId,
          phase: "failover",
          detail:
            result.kind === "busy"
              ? "session host busy — retrying in-page"
              : "session host lost — retrying in-page",
        });
        runner.source = deps.createFallbackSource();
        session.source = runner.source;
        continue;
      }

      // 2. Nothing was rendered, so the round can simply be run again.
      //    A stream that drops before its first token is a transient
      //    failure far more often than it is a real answer of "nothing".
      if (result.kind === "lost" && runner.lostRetries < LOST_ROUND_RETRIES) {
        runner.lostRetries += 1;
        logTurnEvent({
          turnId: null,
          conversationId,
          phase: "failover",
          detail: "round dropped with nothing rendered — retrying it",
        });
        continue;
      }

      // 3. Out of options: explain the loss here, where the round's
      //    outcome is still in hand.
      if (result.kind === "lost" && result.outcome) {
        commitRender(conversationId, result.outcome);
        useChatStore.getState().endStreaming(conversationId, false);
      }
      return true;
    }

    if (result.kind === "exhausted") return true;

    if (result.kind === "done") {
      // Stopping is a checkpoint, not an answer. The model's closing
      // sentence is the weakest evidence in the system, and this harness
      // already holds stronger: the plan it published, and what actually
      // ran against the code in the workspace. Continue when those say
      // the work is open, so a multi-step task does not end on "now I'll
      // wire the route".
      const verdict = completionVerdictFor(conversationId, result.agentTools === true);
      if (verdict.complete) return true;

      if (runner.completionNudges < AGENT_COMPLETION_NUDGES) {
        runner.completionNudges += 1;
        useChatStore.getState().addMessage(conversationId, {
          role: "assistant",
          content: verdict.nudge,
        });
        logTurnEvent({
          turnId: null,
          conversationId,
          phase: "completion-gate",
          detail:
            `unfinished — ${verdict.summary} ` +
            `(continuing ${runner.completionNudges}/${AGENT_COMPLETION_NUDGES})`,
        });
        continue;
      }

      // Out of continuations. Name what is still open instead of the
      // generic checkpoint notice: the user is being asked to take over,
      // and which promise is unkept is the useful half of that.
      useChatStore.getState().addMessage(conversationId, {
        role: "assistant",
        content: continuationExhaustedNotice(verdict.summary),
      });
      logTurnEvent({
        turnId: null,
        conversationId,
        phase: "completion-gate",
        detail: `unfinished and the continuation budget is spent — ${verdict.summary}`,
      });
      return true;
    }

    // Tool calls → execute them here, then loop with results in the transcript.
    const calls = session.toolCalls;
    session.toolCalls = [];
    if (calls.length === 0) return true;
    if (session.abort?.signal.aborted) return true;
    // A completed exchange is progress: the retry the next dead round
    // may need is available again.
    runner.lostRetries = 0;

    session.inToolPhase = true;
    logTurnEvent({
      turnId: null,
      conversationId,
      phase: "tool-phase",
      detail: `${calls.length} calls`,
    });
    try {
      await executeToolPhase(
        conversationId,
        calls,
        withRecoveryNote(conversationId, toolPhaseMeta(conversationId))
      );
    } finally {
      session.inToolPhase = false;
    }

    // ── Braid P1: mid-turn probe (never gates — results land at boundaries) ──
    // Runs the in-browser typecheck against the CURRENT workspace and diffs
    // against the turn-start baseline. Fire-and-forget: the next round is
    // never waited on. New diagnostics are announced as a harness note and
    // feed the strand fork policy's risk signals.
    if (
      useChatStore.getState().settings.braidProbes !== false &&
      !session.abort?.signal.aborted
    ) {
      // Cost gate: the typecheck worker only sees files when they are loaded,
      // so "did anything change since the last probe" is answered by
      // workspace revision — the cheapest correct signal. A probe that
      // would re-read identical bytes is skipped.
      const wsNow = selectWorkspace(useChatStore.getState(), conversationId);
      const revNow = wsNow?.updatedAt ?? -1;
      if (session.lastProbeRevision === revNow) {
        // Nothing changed since the last probe — skip this round's probe.
      } else {
      void (async () => {
        try {
          const state = useChatStore.getState();
          const ws = selectWorkspace(state, conversationId);
          if (!ws) return;
          const { runTypecheck } = await import("../lib/typecheck-client");
          const result = await runTypecheck({
            files: probeFiles(ws),
            tsconfigRaw:
              ws.files["tsconfig.json"]?.content ??
              ws.files["jsconfig.json"]?.content ??
              null,
            treePaths: ws.tree.map((e) => e.path),
            changedPaths: Object.entries(ws.files)
              .filter(([, f]) => f.status !== "unchanged")
              .map(([p]) => p),
          });
          if (session.abort?.signal.aborted) return;
          const baseline = session.probeBaseline;
          if (!baseline) {
            session.probeBaseline = captureProbeBaseline(ws, result);
            return;
          }
          const outcome = diffProbe(baseline, result);
          session.probeBaseline = outcome.baseline ?? baseline;
          if (outcome.ran && outcome.ok && outcome.newDiagnostics.length > 0) {
            session.probeFailures += 1;
            const notice = probeNotice(outcome);
            if (notice) {
              useChatStore.getState().addMessage(conversationId, {
                role: "assistant",
                content: notice,
              });
            }
            logTurnEvent({
              turnId: session.turnId,
              conversationId,
              phase: "braid-probe",
              detail: `probe: ${outcome.newDiagnostics.length} new diagnostic(s), delta ${outcome.deltaErrors}`,
            });
          }
          // Remember what this probe read, so the next round skips the
          // worker entirely when nothing has changed since.
          session.lastProbeRevision = revNow;
        } catch {
          // A probe that cannot run is silent — absent is not failure.
        }
      })();
      }
    }

    // ── Braid P2: risk-signaled strand rollouts (shadow, joined at the stop) ──
    // Fired once per turn, only when the fork policy's risk signals say the
    // turn is losing: stuck refusals or repeated probe findings. Strands run
    // page-side on forks while the main loop CONTINUES — nothing pauses.
    if (
      !session.strandHandle &&
      useChatStore.getState().settings.braidStrandRollouts !== false &&
      (session.stuckRefusals > 0 || session.probeFailures >= 2)
    ) {
      const state = useChatStore.getState();
      const conversation = state.conversations.find((c) => c.id === conversationId);
      const ws = selectWorkspace(state, conversationId);
      const repo = conversation?.repoContext;
      if (conversation && ws && repo && session.abort) {
        const task =
          [...visibleMessages(conversation.messages)].reverse().find((m) => m.role === "user")
            ?.content ?? "";
        const handle = maybeLaunchStrands(
          {
            conversationId,
            conversationModel:
              session.modelOverride ?? conversation.model ?? state.settings.defaultModel,
            // The pick function fills shortfalls with the conversation's own
            // model; a catalog-driven cheaper list can replace this later.
            cheaperModels: [],
            apiKey: state.settings.apiKey.trim(),
            token: state.settings.github.token,
            repoLabel: `${repo.owner}/${repo.repo}@${repo.branch}`,
            task,
            signals: {
              stuckRefusals: session.stuckRefusals,
              probeFailures: session.probeFailures,
              checkFailing: false,
              plan: {
                total: conversation.plan?.steps.length ?? 0,
                done: conversation.plan?.steps.filter((s) => s.status === "done").length ?? 0,
              },
              roundsSpent: 0,
            },
            signal: session.abort.signal,
          },
          ws,
          (note) => {
            useChatStore.getState().addMessage(conversationId, {
              role: "assistant",
              content: note,
            });
          }
        );
        if (handle) {
          session.strandHandle = handle;
          logTurnEvent({
            turnId: session.turnId,
            conversationId,
            phase: "braid-strands",
            detail: `strands launched (${handle.label}): ${handle.reason}`,
          });
        }
      }
    }

    // ── Response ladder ──
    // One assessment of how hard this turn is working, from facts the
    // executor already counted. The ladder consumes it in cost order —
    // the effort bump (same model, more thinking) before the model
    // escalation (a different model, more capability) — and a refusal
    // count above zero is still the trigger for the ladder as a whole:
    // that is the evidence the harness has told the model, in words,
    // that its approach fails.
    //
    // The rungs interleave so the old behaviour is preserved exactly
    // when the new rung cannot fire:
    //
    //   elevated + bump available   → bump; the model rung waits one round
    //                                 to see whether thinking broke the loop
    //   elevated + bump unavailable → swap immediately (what always happened
    //                                 before the thinking rung existed — a
    //                                 model that cannot express effort has
    //                                 no intermediate rung to try)
    //   high (provably stuck)       → swap directly; a turn this stuck does
    //                                 not spend a round on an intermediate rung
    if (session.stuckRefusals > 0) {
      const assessment = assessDifficultyFor(conversationId);
      session.difficulty = assessment;
      logTurnEvent({
        turnId: null,
        conversationId,
        phase: "tool-phase",
        detail: describeDifficulty(assessment),
      });

      const conversation = useChatStore.getState().conversations.find((c) => c.id === conversationId);
      let bumped = false;
      if (
        assessment.level === "elevated" &&
        !session.effortBumped &&
        !session.escalated
      ) {
        bumped = maybeBumpEffort(conversationId, conversation, deps) !== null;
      }

      // The model rung fires whenever the thinking rung did not just fire:
      // a bump is one round of grace, and `high` never earns one.
      if (!bumped && !session.escalated) {
        maybeEscalate(
          conversationId,
          conversation?.model ?? useChatStore.getState().settings.defaultModel,
          deps
        );
      }
    }
  }

  // Every iteration ended in tool calls: the cap, not the model, stopped
  // this turn.
  return false;
}

/**
 * Runs rounds (stream → tools → stream) on a chosen transport, keeping
 * the loop alive across tool-use checkpoints.
 *
 * The iteration cap is a checkpoint, not a stop. When it is reached the
 * agent still holds its tool results and has nothing half-written to
 * redo, so the only thing standing between it and the rest of the task
 * is a sentence the user has to type ("continue"). Stopping there made
 * every multi-file change a manual relay: the loop starts another batch
 * on its own, and only asks for help once the continuation budget is
 * genuinely spent — which is the one case where "continue" is the
 * honest answer rather than a chore.
 */
async function runRounds(conversationId: string, deps: EngineDeps): Promise<void> {
  const session = sessionOf(conversationId);
  const cap = maxIterations(deps);
  const runner: RoundRunner = {
    source: await deps.resolveSource(),
    localFallbacks: 0,
    lostRetries: 0,
    completionNudges: 0,
  };
  session.source = runner.source;

  for (let continuation = 0; ; continuation++) {
    const finished = await runBatch(conversationId, deps, runner, cap);
    if (finished) return;
    if (session.abort?.signal.aborted) return;
    if (continuation >= AGENT_AUTO_CONTINUATIONS) break;

    logTurnEvent({
      turnId: null,
      conversationId,
      phase: "resume",
      detail: `tool-use checkpoint hit — auto-continuing (${continuation + 1}/${AGENT_AUTO_CONTINUATIONS})`,
    });
  }

  useChatStore.getState().addMessage(conversationId, {
    role: "assistant",
    content: TOOL_LIMIT_NOTICE,
  });
}

// ── Braid: the join at the stop + distillation ─────────────

/**
 * Joins any strand rollouts this turn forked, at the stop.
 *
 * The main path's verification is read HERE, at the stop, from the same
 * evidence the completion gate reads: a fresh pass at the CURRENT revision
 * is a verified main path. An aborted turn skips the join entirely — the
 * user stopped everything, and a "strands were joined" note after a stop
 * would be noise about work they just ended.
 */
async function joinBraidAtStop(conversationId: string, session: TurnSessionState): Promise<void> {
  const handle = session.strandHandle;
  if (!handle || session.abort?.signal.aborted) return;
  const state = useChatStore.getState();
  const ws = selectWorkspace(state, conversationId);
  if (!ws) return;
  const fresh = verificationEvidence(conversationId, { workspaceUpdatedAt: ws.updatedAt });
  const mainVerified = fresh.some((e) => e.status === "fresh-pass");
  // Bounded: a strand's model call honors the turn's abort signal, but a
  // wedged network call must not hold the transcript hostage past this.
  await Promise.race([
    handle.join(ws, mainVerified),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
  ]);
}

/**
 * Distills this turn's outcome into strategy entries (Braid P0).
 * Fire-and-forget from the caller's perspective: the next send never
 * waits on it, and a failure here is silent by design — compaction's
 * summarizer already set that policy for background side calls. Runs
 * AFTER the strand join, so it describes the work that survived.
 */
async function distillTurnOutcome(conversationId: string, session: TurnSessionState): Promise<void> {
  if (useChatStore.getState().settings.braidStrategies === false) return;
  const state = useChatStore.getState();
  const conversation = state.conversations.find((c) => c.id === conversationId);
  const repo = conversation?.repoContext;
  if (!conversation || !repo) return;
  const apiKey = state.settings.apiKey.trim();
  if (!apiKey) return;

  const task =
    [...visibleMessages(conversation.messages)].reverse().find((m) => m.role === "user")
      ?.content ?? "";
  const ws = selectWorkspace(state, conversationId);
  const evidence = ws
    ? verificationEvidence(conversationId, { workspaceUpdatedAt: ws.updatedAt })
    : [];
  const notes = [
    ...evidence.map((e) => `${e.summary} (${e.kind}, ${e.status})`),
    ...[...session.callLedger.values()].filter((l) => !l.ok).map((l) => `failing call: ${l.digest}`),
  ].filter(Boolean);

  const lastMessage = conversation.messages[conversation.messages.length - 1];
  const outcome: StrategyEntry["outcome"] = session.abort?.signal.aborted
    ? "stopped"
    : evidence.some((e) => e.status === "fresh-pass")
      ? "verified"
      : lastMessage?.error
        ? "failed"
        : "stopped";

  const modelId = conversation.model ?? state.settings.defaultModel;
  const input = { task, outcomeNotes: notes, outcome };
  // Budget guard: a distill must never outspend the turn it learned from.
  if (estimateDistillTokens(input, modelId) > 6_000) return;

  try {
    const result = await distillTurn({
      ...input,
      conversationId,
      repo,
      apiKey,
      modelId,
    });
    if (result.ok) {
      logTurnEvent({
        turnId: session.turnId,
        conversationId,
        phase: "braid-distill",
        detail: `distilled ${result.stored} strateg${result.stored === 1 ? "y" : "ies"}${result.deduped > 0 ? ` (${result.deduped} deduped)` : ""}`,
      });
    }
  } catch {
    // Silent by design — see the header.
  }
}

// ── Public entry points ─────────────────────────────────────

/**
 * Runs one user turn to completion. Single-flight: a second call
 * while a turn is running is refused (its message is QUEUED by the runner
 * and delivered at the next round boundary, or as the next turn).
 */
export async function runTurn(
  conversationId: string,
  deps: Partial<EngineDeps> = {}
): Promise<void> {
  // Refused only for THIS conversation: a tool phase this chat already started
  // counts as "still running", while a turn belonging to another chat is not
  // this chat's business. Parallelism is the feature; two turns interleaved
  // inside one thread is the bug this guard exists for.
  if (runningSession(conversationId)) return;
  const resolved: EngineDeps = { ...defaultDeps, ...deps };
  const session = sessionOf(conversationId);

  session.phase = "running";
  session.conversationId = conversationId;
  session.abort = new AbortController();
  // Held locally because the finally clears the session field: whether the
  // turn was STOPPED is still the question the tail of this function asks.
  const abort = session.abort;

  session.toolCalls = [];
  session.inToolPhase = false;
  session.callLedger = new Map();
  session.recoveredTextCalls = false;
  session.recoveredNote = null;
  session.modelOverride = null;
  session.escalated = false;
  session.effortOverride = null;
  session.effortBumped = false;
  session.difficulty = null;
  session.stuckRefusals = 0;
  session.probeBaseline = null;
  session.probeFailures = 0;
  session.lastProbeRevision = -1;
  session.strandHandle = null;
  session.sentToolNames = null;
  clearEnvSkillState(conversationId);

  // ── Adaptive initial effort ──
  // AFTER the reset block above: this writes `session.effortOverride`, and
  // a classifier run before the resets would be silently wiped (a bug this
  // ordering exists to prevent).
  //
  // The conversation's own rung is an explicit choice and is never touched.
  // When it is unset (following the settings default) the harness may pick
  // the STARTING rung from what this request looks like — one rung up for
  // deep work, one down for trivial work (the cost lever). Skipped entirely
  // when adaptive effort is off. The turn-prep resolution order already
  // prefers a turn-scoped override, so this reaches the wire unchanged.
  if (useChatStore.getState().settings.adaptiveEffort !== false) {
    const conv = useChatStore
      .getState()
      .conversations.find((c) => c.id === conversationId);
    if (conv && conv.reasoningEffort === undefined) {
      const lastUser = [...visibleMessages(conv.messages)]
        .reverse()
        .find((m) => m.role === "user");
      const { complexity, reasons } = classifyRequest({
        text: lastUser?.content ?? "",
        openPlanSteps: conv.plan
          ? conv.plan.steps.filter((s) => s.status !== "done").length
          : 0,
      });
      const base = useChatStore.getState().settings.defaultReasoningEffort;
      const effort = effortForComplexity(complexity, base);
      if (effort !== base) {
        session.effortOverride = effort;
        logTurnEvent({
          turnId: null,
          conversationId,
          phase: "turn-start",
          detail: `adaptive effort: ${complexity} (${reasons.join("; ")}) — starting at ${effort}`,
        });
      }
    }
  }

  try {
    await runRounds(conversationId, resolved);
    // Braid: strands are joined at the stop (their work is materialized
    // only when it verified better than the main path), and the settled
    // turn is distilled into strategies afterwards. Both are no-ops on a
    // turn that forked nothing.
    //
    // LATENCY RULE: when the user already queued the next instruction, the
    // tail must not make them wait on a strand join (bounded at 120 s) or a
    // distill call. The queued turn starts immediately and the join runs
    // beside it — its last-instant staleness re-check refuses to adopt over
    // anything the new turn has already edited.
    const hasQueued =
      (
        useChatStore
          .getState()
          .conversations.find((c) => c.id === conversationId)?.queued?.length ?? 0
      ) > 0;
    if (hasQueued) {
      void joinBraidAtStop(conversationId, session).then(() =>
        distillTurnOutcome(conversationId, session)
      );
    } else {
      await joinBraidAtStop(conversationId, session);
      await distillTurnOutcome(conversationId, session);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : "turn failed";
    logTurnEvent({
      turnId: session.turnId,
      conversationId,
      phase: "error",
      detail,
    });
    const api = useChatStore.getState();
    const partial = api.streams[conversationId]?.content ?? "";
    api.discardStreaming(conversationId);
    api.endStreaming(conversationId, false);
    api.addMessage(conversationId, {
      role: "assistant",
      content: partial.trim()
        ? `${partial}\n\n— _the turn failed: ${detail}_`
        : `The turn failed: ${detail}`,
      error: true,
    });
  } finally {
    // Last-resort guard: no exit path may leave THIS conversation's spinner
    // running — and nothing here may touch another agent's stream.
    const api = useChatStore.getState();
    if (api.streams[conversationId]) api.endStreaming(conversationId, false);
    // The turn is over, so its record goes with it: nothing may read a tool
    // ledger, a sent-tool surface or an escalated model off a finished turn.
    sessions.delete(conversationId);
    // Safety net: a question whose turn is over has nobody left to answer
    // it, and a waiter that outlives its turn would swallow the next answer
    // into a promise nothing is awaiting. On the reload path there is no
    // waiter, so the persisted question survives untouched for the card.
    settlePendingQuestion(conversationId, null);
    useChatStore.getState().clearPendingTurn(conversationId);
  }

  // Messages the user sent while this turn ran are their NEXT instruction,
  // not part of this one, so they start their own turn rather than sitting
  // in the queue until something else happens. A stop is the exception:
  // "stop" means stop, and the queued text stays in the composer where it
  // can be sent, edited or dropped.
  if (!abort.signal.aborted) startQueuedTurn(conversationId);
}

/**
 * Starts a turn on anything the user queued while the previous one ran.
 *
 * Split out so both exits can use it and neither can double-deliver: the
 * queue is drained with an atomic take, and the transcript is the only
 * place the message ends up.
 */
function startQueuedTurn(conversationId: string): void {
  const conversation = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (!conversation) return;
  // A parked question is an open question: sending a new prompt instead of
  // answering it would throw away the model's tool results.
  if (conversation.pendingQuestion) return;
  if ((conversation.queued?.length ?? 0) === 0) return;
  if (deliverQueuedMessages(conversationId) === 0) return;
  useChatStore.getState().markPendingTurn(conversationId);
  void runTurn(conversationId);
}

/**
 * Adopts a turn the host is still streaming (page reload mid-stream)
 * and continues its tool loop. Returns true when a live turn was
 * adopted; false leaves the pending marker intact so the caller can
 * fall back to plan-based re-streaming.
 */
export async function adoptTurn(
  conversationId: string,
  deps: Partial<EngineDeps> = {}
): Promise<boolean> {
  if (runningSession(conversationId)) return false;
  const resolved: EngineDeps = { ...defaultDeps, ...deps };

  const ready = await sessionHost.connect().catch(() => false);
  if (!ready) return false;

  const source = new HostTurnSource(sessionHost);

  // Buffer from before the snapshot request so deltas emitted in
  // between are replayed instead of lost (the classic mid-adoption
  // text gap).
  const prebuffer: HostEvent[] = [];
  let buffering = true;
  const unsubscribePrebuffer = source.subscribe((event) => {
    if (buffering) prebuffer.push(event);
  });
  let snapshot: HostSnapshot | null;
  try {
    // Scoped to THIS conversation: the host streams one turn per
    // conversation, so an unscoped ask could hand back another chat's
    // turn — which the guard below would reject, silently skipping a
    // resume that was actually available.
    snapshot = await sessionHost.fetchSnapshot(conversationId);
  } finally {
    buffering = false;
    unsubscribePrebuffer();
  }
  if (!snapshot?.turnId || snapshot.conversationId !== conversationId) return false;

  let adopted = false;
  const session = sessionOf(conversationId);

  session.phase = "running";
  session.conversationId = conversationId;
  session.source = source;
  session.turnId = snapshot.turnId;
  session.abort = new AbortController();
  session.toolCalls = [];
  session.inToolPhase = false;
  session.callLedger = new Map();
  session.recoveredTextCalls = false;
  session.recoveredNote = null;
  session.modelOverride = null;
  session.escalated = false;
  session.stuckRefusals = 0;
  session.probeBaseline = null;
  session.probeFailures = 0;
  session.strandHandle = null;
  // The adopted turn's surface died with the page that prepared it, so it is
  // unknown rather than empty — unknown does not refuse a call.
  session.sentToolNames = null;

  logTurnEvent({
    turnId: snapshot.turnId,
    conversationId,
    phase: "resume",
    detail: "adopted live host turn",
  });

  try {
    const outcome = await renderTurn(
      conversationId,
      source,
      snapshot.turnId,
      snapshot,
      resolved.inactivityTimeoutMs,
      prebuffer
    );

    const committedId = commitRender(conversationId, outcome, undefined);
    useChatStore
      .getState()
      .endStreaming(conversationId, outcome.kind === "end" && outcome.reason === "aborted");
    logTurnEvent({
      turnId: snapshot.turnId,
      conversationId,
      phase: "stream-end",
      detail: `adopted turn ${outcome.kind === "end" ? outcome.reason : "lost"}`,
    });

    // Lost before producing anything: report "not adopted" so the
    // caller re-streams from the transcript instead of leaving the
    // turn dead. The marker must survive that decision.
    if (outcome.kind === "lost" && !committedId) return false;
    adopted = true;

    // Continue the agent loop when the adopted round ended with tools
    if (
      outcome.kind === "end" &&
      outcome.reason === "tool-calls" &&
      session.toolCalls.length > 0 &&
      !session.abort.signal.aborted
    ) {
      const calls = session.toolCalls;
      session.toolCalls = [];
      session.inToolPhase = true;
      try {
        await executeToolPhase(
        conversationId,
        calls,
        withRecoveryNote(conversationId, toolPhaseMeta(conversationId))
      );
      } finally {
        session.inToolPhase = false;
      }
      await runRounds(conversationId, resolved);
    }
    return adopted;
  } catch (err) {
    logTurnEvent({
      turnId: snapshot.turnId,
      conversationId,
      phase: "error",
      detail: err instanceof Error ? err.message : "adoption failed",
    });
    return false;
  } finally {
    const api = useChatStore.getState();
    if (api.streams[conversationId]) api.endStreaming(conversationId, false);
    sessions.delete(conversationId);
    if (adopted) useChatStore.getState().clearPendingTurn(conversationId);
  }
}

/**
 * Stops the in-flight turn of one conversation, or of every one running.
 *
 * The unnamed form is the app-wide Stop (the palette's, a keyboard shortcut):
 * with several agents working, "stop" from a surface that names no thread means
 * the user wants the work to end, not just the chat they happen to be on. A
 * caller that DOES know which thread it means passes its id, so one agent's
 * stop never touches a peer's turn.
 *
 * Both the transport turn AND the local controller are aborted. The transport
 * abort stops the stream; the controller is what every page-side wait checks —
 * a tool holding the turn, the next round, and the completion gate's "a stop
 * always wins". Aborting only the transport left the tool loop free to nudge
 * the model onward after the user had already ended it.
 *
 * Returns how many turns were stopped, so a caller can report it.
 */
export function stopTurn(conversationId?: string): number {
  const targets = conversationId
    ? liveSessions().filter((s) => s.conversationId === conversationId)
    : liveSessions();

  for (const target of targets) {
    // A parked approval is a wait, and a wait that outlives its turn leaves
    // that agent parked behind a dialog for work the user has ended.
    if (target.conversationId) {
      useChatStore.getState().dismissApprovalsFor(target.conversationId, STOPPED_BY_USER);
    }
    if (target.turnId && target.source) target.source.abortTurn(target.turnId);
    target.abort?.abort();
  }
  return targets.length;
}

/**
 * A live turn describes ONE thread on ONE repository, so a move ends it.
 *
 * This is the same rule the browser workspace states (container-host.ts): a
 * turn's request, its working copy and its tool results are all about the
 * revision it started on, and a turn that survived a repository switch would
 * keep reading and writing files in a repository it was never prepared for —
 * producing evidence about code that is no longer in play. Ending it is honest:
 * the partial reply is committed, the marker is cleared, and the user can send
 * again into the new context.
 *
 * Scoped to the thread that moved. A peer agent on another thread (or on the
 * same repository under another binding) keeps working, which is now the
 * ordinary case rather than an oversight: over-releasing is the mistake in the
 * other direction (see scoped-resources.ts).
 */
registerScopedResource({
  name: "session.turn",
  scope: "binding",
  release: ({ transition }) => {
    if (transition.type === "thread.created") return;
    // stopTurn already filters `liveSessions()` to the named thread, so this is
    // naturally scoped — but the named thread may simply have no live turn, and
    // asking an idle engine to stop is a no-op worth not paying a transition
    // dispatch for. Read the same live set rather than a parallel record of it.
    if (!liveSessions().some((s) => s.conversationId === transition.threadId)) return;
    stopTurn(transition.threadId);
  },
});

/**
 * Waits for the engine to go idle again — one conversation, or all of them.
 *
 * Defaults to the conversation when one is named; the unnamed form is what a
 * test or an eval that drove a single turn means.
 */
export async function waitForIdle(
  conversationIdOrTimeout?: string | number,
  timeoutMs = 5_000
): Promise<boolean> {
  const conversationId =
    typeof conversationIdOrTimeout === "string" ? conversationIdOrTimeout : undefined;
  const budget = typeof conversationIdOrTimeout === "number" ? conversationIdOrTimeout : timeoutMs;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (!isTurnRunning(conversationId)) return true;
    await sleep(10);
  }
  return !isTurnRunning(conversationId);
}

/** Re-exported host usage shape for callers of the engine */
export type { HostUsage };
