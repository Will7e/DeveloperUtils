// ============================================================
// Turn Engine — The One Place Turn Semantics Live
// ============================================================
// Both transports (SharedWorker host, page-local) drive the same
// HostTurnController and emit the same HostEvent stream, so this
// engine owns every turn rule exactly once:
//
//  - rounds: prepare → start → render → (tool calls? run them → next
//    round). Tool EXECUTION stays here because the workspace and the
//    preview live in the page.
//  - the renderer, including an inactivity watchdog: silence from
//    the transport (killed worker, dropped port) ends the turn with
//    an honest error instead of a spinner that never stops.
//  - the fallback rule: if the survivable transport refuses or dies
//    before anything was committed, retry the round once on the
//    page-local transport. Never duplicate already-committed output.
//  - commit semantics per end reason, telemetry → learning router,
//    token calibration, and clearing the pending-turn marker on
//    every exit path.
//
// State lives in ONE explicit session object (no ambient module
// flags), and a turn is single-flight: a second run while running is
// refused rather than interleaved.

import { useChatStore } from "@/stores/chat.store";
import { usePreviewStore } from "../preview/preview.store";
import {
  prepareTurn,
  resolveCandidates,
  type PreparedTurn,
  type TurnPreparation,
} from "../services/turn-prep";
import { executeToolCall, serializeToolResult, parseToolArguments } from "../lib/tools";
import { lookupToolCache, storeToolCache, toolCacheKey } from "../lib/tool-cache";
import { validateToolCall, getToolMeta } from "../lib/tool-registry";
import {
  displayNameFor,
  isIntabModel,
  recordDailyRequest,
  recordModelFailure,
  recordModelSuccess,
} from "../lib/intab-llm";
import { recordFeedback } from "../lib/intab-learn";
import { recordUsageCalibration } from "../context/tokenizer-calibration";
import { estimateTokens } from "../context/tokenizer";
import {
  AGENT_MAX_ITERATIONS,
  AGENT_ITERATIONS_MAX,
  INTAB_MODEL_ID,
  INTAB_MODEL_NAME,
  TOOL_EXECUTION_CONCURRENCY,
  TURN_INACTIVITY_TIMEOUT_MS,
} from "../constants";
import {
  resetPreviewExecCounter,
  runCreateWorkingBranch,
  runDeleteFile,
  runInPreview,
  runPreviewFeedback,
  runPushChanges,
  runQueryPreviewDom,
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
  HostTelemetryEvent,
  HostUsage,
} from "./protocol";
import type { TurnKind } from "../lib/intab-classify";
import type {
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
}

const session: TurnSessionState = {
  phase: "idle",
  conversationId: null,
  source: null,
  turnId: null,
  abort: null,
  toolCalls: [],
  inToolPhase: false,
};

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
  prepare: (conversationId: string) => Promise<TurnPreparation>;
  /** Transport used when the survivable one refuses or dies */
  createFallbackSource: () => TurnSource;
  /** Renderer inactivity ceiling (transport silence → turn ends) */
  inactivityTimeoutMs: number;
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
    case "REROUTE_NEEDED":
      return event.turnId === turnId;
    case "TELEMETRY":
      return event.event.turnId === turnId;
    default:
      return false;
  }
}

/** Mirrors transport-observed model outcomes into the learning router */
function recordTelemetry(event: HostTelemetryEvent): void {
  const turnKind = (event.turnKind as TurnKind) ?? "analysis";
  switch (event.kind.type) {
    case "modelSuccess":
      recordModelSuccess(event.kind.modelId);
      break;
    case "modelFailure":
      recordModelFailure(event.kind.modelId, event.kind.reason, event.kind.headers);
      break;
    case "dailyRequest":
      recordDailyRequest(event.kind.modelId);
      break;
    case "turnSuccess":
      recordFeedback(event.kind.modelId, turnKind, "success");
      break;
    case "turnEmpty":
      recordFeedback(event.kind.modelId, turnKind, "empty");
      break;
    case "turnAbort":
      recordFeedback(event.kind.modelId, turnKind, "abort");
      break;
    case "turnFailover":
      recordFeedback(event.kind.modelId, turnKind, "failover");
      break;
  }
}

function isInTabConversation(conversationId: string): boolean {
  const state = useChatStore.getState();
  const conv = state.conversations.find((c) => c.id === conversationId);
  return isIntabModel(conv?.model ?? state.settings.defaultModel);
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
  const intab = conv
    ? isIntabModel(conv.model ?? useChatStore.getState().settings.defaultModel)
    : false;
  const last = conv && conv.messages.length > 0 ? conv.messages[conv.messages.length - 1] : undefined;
  const wireModel =
    last?.viaInTab || isIntabModel(last?.model) ? INTAB_MODEL_ID : (last?.model ?? "");
  return { content: "", reasoning: "", model: intab ? INTAB_MODEL_ID : wireModel };
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
        case "TELEMETRY": {
          recordTelemetry(event.event);
          break;
        }
        case "REROUTE_NEEDED": {
          if (event.turnId !== turnId) return;
          const conv = useChatStore
            .getState()
            .conversations.find((c) => c.id === conversationId);
          if (!conv) return;
          const requested = conv.model ?? useChatStore.getState().settings.defaultModel;
          const fresh = resolveCandidates({
            conversation: conv,
            requestedModel: requested,
            exclude: new Set(event.excluded),
          });
          const candidates = fresh.candidates.filter(
            (c) => !event.excluded.includes(c.modelId)
          );
          logTurnEvent({
            turnId,
            conversationId,
            phase: "reroute",
            detail: `${candidates.length} fresh candidates`,
          });
          source.sendReroute(turnId, candidates);
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
  const intab = isInTabConversation(conversationId);
  const model = intab
    ? INTAB_MODEL_ID
    : (outcome.modelId ?? fallbackModelId ?? undefined);
  const reasoning = (streamedReasoning || outcome.reasoning) || undefined;

  if (outcome.kind === "lost") {
    api.discardStreaming();
    if (streamed.trim()) {
      return api.commitDirectAssistantMessage(conversationId, {
        content: `${streamed}\n\n— _the response engine stopped responding; partial reply kept._`,
        reasoning,
        model,
        viaInTab: intab || undefined,
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
        viaInTab: intab || undefined,
        usage: outcome.usage,
      });
    }
    case "aborted": {
      return api.commitDirectAssistantMessage(conversationId, {
        content: streamed || outcome.content,
        reasoning,
        model,
        viaInTab: intab || undefined,
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
          viaInTab: intab || undefined,
          usage: outcome.usage,
        });
      }
      return api.commitDirectAssistantMessage(conversationId, {
        content:
          outcome.error ??
          `${displayNameFor(model, [])} could not complete this response. Try again shortly.`,
        model,
        viaInTab: intab || undefined,
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
  switch (name) {
    case "write_file":
      return runWriteFile(conversationId, args);
    case "delete_file":
      return runDeleteFile(conversationId, args);
    case "create_working_branch":
      return runCreateWorkingBranch(conversationId, args);
    case "push_changes":
      return runPushChanges(conversationId, args);
    case "get_preview_feedback": {
      const buildErrors = usePreviewStore
        .getState()
        .diagnostics.filter((d) => d.severity === "error")
        .map(
          (d) =>
            `${d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : "build: "}${d.message.split("\n")[0] ?? d.message}`
        );
      return runPreviewFeedback(conversationId, args, buildErrors);
    }
    case "run_in_preview":
      return runInPreview(conversationId, args);
    case "query_preview_dom":
      return runQueryPreviewDom(conversationId, args);
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
    call: ToolCallRequest;
    cacheKey: string | null;
  }
  const pending: PendingTool[] = [];
  calls.forEach((call, idx) => {
    const validation = validateToolCall(call.name, call.arguments);
    if (!validation.ok) {
      results.set(idx, {
        callId: call.id,
        name: call.name,
        ok: false,
        data: { error: validation.error },
        durationMs: 0,
        summary: "invalid arguments",
      });
      return;
    }
    const cacheKey = repoContext ? toolCacheKey(call, repoContext) : null;
    const hit = lookupToolCache(cacheKey);
    if (hit) {
      results.set(idx, { ...hit, callId: call.id, durationMs: 0 });
    } else {
      pending.push({ idx, call, cacheKey });
    }
  });
  drainOrdered();

  if (pending.length > 0 && repoContext) {
    await runOrderedPool(
      pending.map((p) => {
        const kind = getToolMeta(p.call.name)?.kind;
        if (kind === "bridge") {
          const args = parseToolArguments(p.call.arguments);
          return {
            run: () =>
              runBridgeTool(conversationId, p.call.name, args).then((result) => ({
                ...result,
                callId: p.call.id,
              })),
            onSettled: (result: ToolCallResult) => {
              results.set(p.idx, result);
              drainOrdered();
            },
          };
        }
        return {
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
          onSettled: (result: ToolCallResult) => {
            results.set(p.idx, result);
            drainOrdered();
          },
        };
      }),
      TOOL_EXECUTION_CONCURRENCY,
      () => session.abort?.signal.aborted ?? false
    );
  }
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
  const prepared = await deps.prepare(conversationId);
  if (prepared === null) return { kind: "done", committed: false };
  if (prepared === "exhausted") return { kind: "exhausted", committed: false };

  const turn = prepared as PreparedTurn;
  const turnId = createTurnId();
  session.turnId = turnId;

  const payload: HostStartTurnPayload = {
    turnId,
    conversationId,
    apiKey: useChatStore.getState().settings.apiKey.trim(),
    systemPrompt: turn.systemPrompt,
    temperature: turn.temperature,
    messages: turn.messages,
    tools: turn.tools,
    candidates: turn.ranked,
    turnKind: turn.turnKind,
  };

  logTurnEvent({
    turnId,
    conversationId,
    phase: "turn-start",
    detail: `${source.label} transport · ${turn.ranked.length} candidates`,
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

  // Token calibration for the exact payload we sent
  if (outcome.usage?.promptTokens != null) {
    const assigned = outcome.modelId ?? turn.modelId;
    const toolSchemaTokens = turn.tools
      ? estimateTokens(JSON.stringify(turn.tools), assigned)
      : 0;
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

/** Runs rounds (stream → tools → stream) on a chosen transport */
async function runRounds(conversationId: string, deps: EngineDeps): Promise<void> {
  const cap = maxIterations();
  let source = await deps.resolveSource();
  session.source = source;

  let localFallbacks = 0;
  let hitCapWithTools = false;

  for (let iteration = 0; iteration < cap; iteration++) {
    if (session.abort?.signal.aborted) return;

    const result = await runRound(conversationId, source, deps);

    // Transport refused (another conversation owns the host) or went
    // silent: retry ONCE in-page — but only when nothing was committed,
    // so a partial reply is never duplicated by a second full answer.
    if (result.kind === "busy" || result.kind === "lost") {
      if (result.committed) return;
      if (!source.survivable || localFallbacks > 0) {
        // No retry left on another transport: explain the loss here,
        // where the round's outcome is still in hand.
        if (result.kind === "lost" && result.outcome) {
          commitRender(conversationId, result.outcome);
          useChatStore.getState().endStreaming(false);
        }
        return;
      }
      localFallbacks += 1;
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
      source = deps.createFallbackSource();
      session.source = source;
      continue;
    }

    if (result.kind === "done" || result.kind === "exhausted") return;

    // Tool calls → execute them here, then loop with results in the transcript.
    const calls = session.toolCalls;
    session.toolCalls = [];
    if (calls.length === 0) return;
    if (session.abort?.signal.aborted) return;

    session.inToolPhase = true;
    logTurnEvent({
      turnId: null,
      conversationId,
      phase: "tool-phase",
      detail: `${calls.length} calls`,
    });
    try {
      await executeToolPhase(conversationId, calls, toolPhaseMeta(conversationId));
    } finally {
      session.inToolPhase = false;
    }

    if (iteration === cap - 1) hitCapWithTools = true;
  }

  if (hitCapWithTools && !session.abort?.signal.aborted) {
    useChatStore.getState().addMessage(conversationId, {
      role: "assistant",
      content:
        "Reached the tool-use limit for this turn. Ask me to continue and I'll pick up where I left off.",
    });
  }
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
  resetPreviewExecCounter(conversationId);

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
        await executeToolPhase(conversationId, calls, toolPhaseMeta(conversationId));
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
