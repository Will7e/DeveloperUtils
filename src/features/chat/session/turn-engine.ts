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
// State lives in ONE explicit session object (no ambient module
// flags), and a turn is single-flight: a second run while running is
// refused rather than interleaved.

import { useChatStore } from "@/stores/chat.store";
import {
  prepareTurn,
  resolveModelState,
  type PreparedTurn,
  type TurnPreparation,
} from "../services/turn-prep";
import { executeToolCall, serializeToolResult, parseToolArguments } from "../lib/tools";
import { lookupToolCache, storeToolCache, toolCacheKey } from "../lib/tool-cache";
import { validateToolCall, getToolMeta, isPlanSafeTool, isValidToolName } from "../lib/tool-registry";
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
import { getCachedModelCatalog, modelDisplayName } from "../lib/model-catalog";
import {
  canEscalate,
  escalationNote,
  noEscalationReason,
  pickEscalationTarget,
  type EscalationOptions,
  type EscalationTargetChoice,
} from "../lib/escalation";
import { recordUsageCalibration } from "../context/tokenizer-calibration";
import { estimateTokens, estimateToolSchemaTokens } from "../context/tokenizer";
import {
  AGENT_AUTO_CONTINUATIONS,
  AGENT_MAX_ITERATIONS,
  AGENT_ITERATIONS_MAX,
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
  runRemember,
  runRunChecks,
  runCiVerification,
  runSearchWorkspace,
  runShellCommand,
  runWorkspaceDiff,
  runWriteFile,
} from "../services/agent-actions";
import { sessionHost } from "./session-client";
import { HostTurnSource, LocalTurnSource, type StartOutcome, type TurnSource } from "./turn-source";
import { logTurnEvent } from "./turn-log";
import type {
  HostEndReason,
  HostEvent,
  HostSnapshot,
  HostStartTurnPayload,
  HostUsage,
} from "./protocol";
import type {
  ChatMode,
  ReasoningEffort,
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
   * Count of calls the repetition policy had to REFUSE this turn because
   * the model kept repeating a failing one. A refusal only happens after
   * the same call has failed twice and been demanded to change, so one
   * refusal is already "the model is stuck" — and it is the signal
   * escalation acts on.
   */
  stuckRefusals: number;
}

const session: TurnSessionState = {
  phase: "idle",
  conversationId: null,
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
  stuckRefusals: 0,
};

/** Identical executions allowed before the ledger takes over */
const REPEAT_MAX_EXECUTIONS = 2;
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

export function getSessionState(): Readonly<TurnSessionState> {
  return session;
}

export function isTurnRunning(): boolean {
  return session.phase === "running";
}

/**
 * True when losing this page would lose real work: a page-local
 * stream dies with the document, and a tool phase's edits are not
 * replayed on resume. Host-mode streaming is reload-surviving, so
 * guarding it would fight the feature it exists to provide.
 */
export function isTurnUnrecoverable(): boolean {
  if (session.phase === "idle") return false;
  return session.inToolPhase || !session.source?.survivable;
}

// ── Injectable seams (tests) ────────────────────────────────

export interface EngineDeps {
  /** Chooses the transport for a turn */
  resolveSource: () => Promise<TurnSource>;
  /** Request preparation (context engine, routing, compaction) */
  prepare: (
    conversationId: string,
    opts?: { modelOverride?: string }
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

function maxIterations(): number {
  const configured = useChatStore.getState().settings.agentMaxIterations;
  return Math.max(
    1,
    Math.min(AGENT_ITERATIONS_MAX, Math.round(configured) || AGENT_MAX_ITERATIONS)
  );
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
function withRecoveryNote(meta: { content: string; reasoning: string; model: string }): {
  content: string;
  reasoning: string;
  model: string;
} {
  const note = session.recoveredNote;
  session.recoveredNote = null;
  if (!note) return meta;
  return { ...meta, content: [meta.content, note].filter(Boolean).join("\n\n") };
}

/** Runs tasks with bounded concurrency; results drain in submit order */
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
    }
  | { kind: "lost"; content: string; reasoning: string; modelId?: string; usage?: UsageInfo };

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
  const api = useChatStore.getState();
  if (!api.isStreaming) api.beginStreaming(conversationId);

  let content = "";
  let reasoning = "";
  let modelId: string | undefined;
  let usage: UsageInfo | undefined;
  let endReason: HostEndReason | null = null;
  let endError: string | undefined;
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
    useChatStore.getState().appendStreamingContent(seedContent);
    content += seedContent;
  }
  if (seedReasoning) {
    useChatStore.getState().appendStreamingReasoning(seedReasoning);
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
          if (c) useChatStore.getState().appendStreamingContent(c);
          if (r) useChatStore.getState().appendStreamingReasoning(r);
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

  if (lost) return { kind: "lost", content, reasoning, modelId, usage };
  return {
    kind: "end",
    reason: endReason ?? "failed",
    error: endError,
    modelId,
    usage,
    content,
    reasoning,
  };
}

/** Commits the rendered turn per end reason; returns the message id */
function commitRender(
  conversationId: string,
  outcome: RenderOutcome,
  fallbackModelId?: string
): string | null {
  const api = useChatStore.getState();
  const streamed = api.streamingContent;
  const streamedReasoning = api.streamingReasoning;
  // The model id IS the wire model now — no virtual-model masking.
  const model = outcome.modelId ?? fallbackModelId ?? undefined;
  const reasoning = (streamedReasoning || outcome.reasoning) || undefined;
  const meta = { effort: session.effort, mode: session.mode };

  if (outcome.kind === "lost") {
    api.discardStreaming();
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

/** Routes coding-agent bridge tools (write/ship/verify) to executors */
async function runBridgeTool(
  conversationId: string,
  name: ToolName,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  // Plan-mode hard guard. Plan mode never RECEIVES the mutating tool
  // definitions, so a call for one is either a hallucination or a
  // stale transcript echoing an old Build turn — refuse it here as
  // well, because the model visibly trying to edit is exactly the
  // failure mode Plan mode exists to prevent.
  const conversation = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  if (resolveModelState(conversation).mode === "plan" && !isPlanSafeTool(name)) {
    return {
      callId: "",
      name,
      ok: false,
      data: {
        error:
          `Tool "${name}" is unavailable in Plan mode. Analyze and propose a plan instead; ` +
          `the user must switch to Build mode before any file can be changed.`,
      },
      durationMs: 0,
      summary: "blocked in plan mode",
    };
  }

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
      return runPushChanges(conversationId, args);
    case "run_checks":
      return runRunChecks(conversationId, args);
    case "update_plan":
      return runUpdatePlan(conversationId, args);
    case "list_mcp_tools":
      return runListMcpTools(conversationId, args);
    case "call_mcp_tool":
      return runCallMcpTool(conversationId, args);
    case "run_command":
      return runShellCommand(conversationId, args);
    case "verify_with_ci":
      return runCiVerification(conversationId, args);
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
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const repoContext = conversation?.repoContext;
  const settings = store.settings;

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
  }

  /**
   * Records one execution outcome against the turn ledger. Every path
   * that produces a result reports here — including cached hits and
   * argument failures — so the repetition policy sees the whole truth
   * rather than only the calls that reached the network.
   */
  const record = (call: ToolCallRequest, result: ToolCallResult): void => {
    const signature = callSignature(call.name, call.arguments);
    const prior = session.callLedger.get(signature);
    session.callLedger.set(signature, {
      count: (prior?.count ?? 0) + 1,
      ok: result.ok,
      digest: result.summary ?? (result.ok ? "ok" : "failed"),
      resultText: serializeToolResult(result).slice(0, LEDGER_RESULT_MAX_CHARS),
    });
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
    if (!validation.ok) {
      const failure: ToolCallResult = {
        callId: call.id,
        name: call.name,
        ok: false,
        data: { error: validation.error },
        durationMs: 0,
        summary: "invalid arguments",
      };
      record(normalized, failure);
      results.set(idx, failure);
      return;
    }
    const cacheKey = repoContext ? toolCacheKey(normalized, repoContext) : null;
    const hit = lookupToolCache(cacheKey);
    if (hit) {
      const cached: ToolCallResult = { ...hit, callId: call.id, durationMs: 0 };
      record(normalized, cached);
      results.set(idx, cached);
    } else {
      pending.push({ idx, call: normalized, cacheKey });
    }
  });
  drainOrdered();

  if (pending.length > 0 && repoContext) {
    const isBridge = (p: PendingTool) => getToolMeta(p.call.name)?.kind === "bridge";
    const settle = (p: PendingTool) => (result: ToolCallResult) => {
      record(p.call, result);
      results.set(p.idx, result);
      drainOrdered();
    };

    // Writes first, one at a time, in submission order. Every bridge
    // tool is a read-modify-write on the same workspace snapshot, so
    // running them concurrently made the last write win and silently
    // discard its siblings' files. Sequential execution also makes
    // `push_changes` observe the edits that preceded it in the same
    // model turn.
    const bridgeTools = pending.filter(isBridge);
    for (const p of bridgeTools) {
      if (session.abort?.signal.aborted) return;
      const args = parseToolArguments(p.call.arguments);
      const result = await runBridgeTool(conversationId, p.call.name, args);
      settle(p)({ ...result, callId: p.call.id });
    }

    // Reads (and batched read programs) then fan out — they are
    // independent and hit the network.
    const readTools = pending.filter((p) => !isBridge(p));
    if (readTools.length > 0) {
      await runOrderedPool(
        readTools.map((p) => ({
          run: () =>
            executeToolCall(p.call, {
              token: settings.github.token,
              repo: repoContext,
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
  const store = useChatStore.getState();
  if (!canEscalate({ enabled: store.settings.autoEscalate, alreadyEscalated: session.escalated })) {
    return;
  }
  // The model that got stuck is the one this turn is running on — which
  // may already be an escalated model, in which case nothing else to try.
  const from = session.modelOverride ?? fromModel;
  const choice = deps.pickEscalation(from, {
    enabled: store.settings.autoEscalate,
    preferred: store.settings.escalationModel,
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
}

async function runRound(
  conversationId: string,
  source: TurnSource,
  deps: EngineDeps
): Promise<RoundResult> {
  const prepared = await deps.prepare(conversationId, {
    modelOverride: session.modelOverride ?? undefined,
  });
  if (prepared === null) return { kind: "done", committed: false };

  const turn: PreparedTurn = prepared;
  const turnId = createTurnId();
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
    useChatStore.getState().discardStreaming();
    useChatStore.getState().endStreaming(false);
    session.turnId = null;
    return { kind: "lost", committed: false, outcome };
  }

  const committedId = commitRender(conversationId, outcome, turn.modelId);
  useChatStore
    .getState()
    .endStreaming(outcome.kind === "end" && outcome.reason === "aborted");
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
    return { kind: "done", committed: Boolean(committedId) };
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
  for (let iteration = 0; iteration < cap; iteration++) {
    if (session.abort?.signal.aborted) return true;

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
        useChatStore.getState().discardStreaming();
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
        useChatStore.getState().endStreaming(false);
      }
      return true;
    }

    if (result.kind === "done" || result.kind === "exhausted") return true;

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
      await executeToolPhase(conversationId, calls, withRecoveryNote(toolPhaseMeta(conversationId)));
    } finally {
      session.inToolPhase = false;
    }

    // ── Escalation ──
    // The model has been told, in words, that the call it keeps making
    // fails, and it made it again. Continuing on the same model just
    // repeats the argument: hand the rest of the turn to something with
    // more capability, announce it, and let the loop continue.
    if (session.stuckRefusals > 0 && !session.escalated) {
      const conversation = useChatStore.getState().conversations.find((c) => c.id === conversationId);
      maybeEscalate(
        conversationId,
        conversation?.model ?? useChatStore.getState().settings.defaultModel,
        deps
      );
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
  const cap = maxIterations();
  const runner: RoundRunner = {
    source: await deps.resolveSource(),
    localFallbacks: 0,
    lostRetries: 0,
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
    content:
      "Reached the tool-use limit for this turn and the automatic continuations are spent. " +
      "Ask me to continue and I'll pick up where I left off.",
  });
}

// ── Public entry points ─────────────────────────────────────

/**
 * Runs one user turn to completion. Single-flight: a second call
 * while a turn is running is refused (the caller's message stays in
 * the transcript and the user can resend).
 */
export async function runTurn(
  conversationId: string,
  deps: Partial<EngineDeps> = {}
): Promise<void> {
  // A tool phase started in this conversation counts as "still running".
  if (session.phase !== "idle") return;
  const resolved: EngineDeps = { ...defaultDeps, ...deps };

  session.phase = "running";
  session.conversationId = conversationId;
  session.abort = new AbortController();
  session.toolCalls = [];
  session.inToolPhase = false;
  session.callLedger = new Map();
  session.recoveredTextCalls = false;
  session.recoveredNote = null;
  session.modelOverride = null;
  session.escalated = false;
  session.stuckRefusals = 0;

  try {
    await runRounds(conversationId, resolved);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "turn failed";
    logTurnEvent({
      turnId: session.turnId,
      conversationId,
      phase: "error",
      detail,
    });
    const api = useChatStore.getState();
    const partial = api.streamingContent;
    api.discardStreaming();
    api.endStreaming(false);
    api.addMessage(conversationId, {
      role: "assistant",
      content: partial.trim()
        ? `${partial}\n\n— _the turn failed: ${detail}_`
        : `The turn failed: ${detail}`,
      error: true,
    });
  } finally {
    // Last-resort guard: no exit path may leave a spinner running.
    const api = useChatStore.getState();
    if (api.isStreaming && api.streamingConversationId === conversationId) {
      api.endStreaming(false);
    }
    session.phase = "idle";
    session.conversationId = null;
    session.source = null;
    session.turnId = null;
    session.abort = null;
    session.toolCalls = [];
    session.inToolPhase = false;
    session.callLedger = new Map();
    session.recoveredTextCalls = false;
    session.recoveredNote = null;
    useChatStore.getState().clearPendingTurn(conversationId);
  }
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
  if (session.phase !== "idle") return false;
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
    snapshot = await sessionHost.fetchSnapshot();
  } finally {
    buffering = false;
    unsubscribePrebuffer();
  }
  if (!snapshot?.turnId || snapshot.conversationId !== conversationId) return false;

  let adopted = false;

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
      .endStreaming(outcome.kind === "end" && outcome.reason === "aborted");
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
        await executeToolPhase(conversationId, calls, withRecoveryNote(toolPhaseMeta(conversationId)));
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
    if (api.isStreaming && api.streamingConversationId === conversationId) {
      api.endStreaming(false);
    }
    session.phase = "idle";
    session.conversationId = null;
    session.source = null;
    session.turnId = null;
    session.abort = null;
    session.toolCalls = [];
    session.inToolPhase = false;
    session.callLedger = new Map();
    session.recoveredTextCalls = false;
    session.recoveredNote = null;
    if (adopted) useChatStore.getState().clearPendingTurn(conversationId);
  }
}

/** Stops the in-flight turn (partial output is preserved by the commit) */
export function stopTurn(): void {
  const api = useChatStore.getState();
  if (!api.isStreaming && session.phase === "idle") return;
  if (session.turnId && session.source) {
    session.source.abortTurn(session.turnId);
    return;
  }
  session.abort?.abort();
}

/** Exposed for tests/UI: waits for the engine to go idle again */
export async function waitForIdle(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.phase === "idle") return true;
    await sleep(10);
  }
  return session.phase === "idle";
}

/** Re-exported host usage shape for callers of the engine */
export type { HostUsage };
