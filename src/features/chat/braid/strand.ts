// ============================================================
// Strand Runtime — Bounded Parallel Rollouts (Braid P2)
// ============================================================
// A strand is a full agent rollout on an ISOLATED FORK of the
// workspace, run with a restricted tool surface and a hard round cap,
// producing a verified-or-unverified result. Strands exist so that a
// turn the main loop is losing (repeated failing calls, failing
// checks, a stalled plan) can be rescued by bounded parallel attempts
// instead of by the user watching a stuck model grind.
//
// SHADOW, NOT REPLACEMENT: strands run page-side while the main turn
// keeps working. The join happens at the stop (braid-decide), and if
// the main path verified itself first, every strand is discarded — its
// cost was the insurance premium, and no wall-clock was added to the
// visible turn.
//
// Hard rules:
//   • restricted surface: the strand model is offered read/edit/write/
//     check tools only. No push, no MCP writes, no ask_user, no app
//     tools, no preview drives — a forked rollout must never be able
//     to touch anything outside its own copy.
//   • every executor call goes through `assertStrandCall`, which
//     refuses anything outside the surface BY NAME, before arguments
//     are parsed or executed. The surface is enforced here even if a
//     caller forgets to filter the offered list.
//   • round cap: a strand that burns its cap without a verified result
//     ends unverified. There is no strand-level escalation.
//   • fork isolation: every read/write the strand performs resolves
//     against the fork's snapshot value, never against the store.

import type { ToolCallRequest, ToolCallResult, ToolName } from "../types";

/** The tools a strand may be offered and may call — nothing else */
export const STRAND_TOOL_NAMES: ReadonlySet<ToolName> = new Set<ToolName>([
  "read_file",
  "search_workspace",
  "get_workspace_diff",
  "write_file",
  "edit_file",
  "delete_file",
  "run_checks",
  "update_plan",
] as ToolName[]);

/** Rounds one strand may spend, total (the main loop's cap is 24) */
export const STRAND_MAX_ROUNDS = 8;

/** Refusal text for a call outside the strand surface */
export function strandRefusalText(name: string): string {
  return (
    `Tool "${name}" is not available in this strand rollout. ` +
    `A strand may only read, edit and check its own forked copy of the workspace ` +
    `(${[...STRAND_TOOL_NAMES].join(", ")}).`
  );
}

/** True when a call is inside the strand surface */
export function isStrandCall(name: ToolName): boolean {
  return STRAND_TOOL_NAMES.has(name);
}

/**
 * Surface enforcement for one strand tool call. Runs BEFORE argument
 * parsing and BEFORE any executor — the same shape as the engine's
 * `withheldRefusal`, but for the strand's own, much smaller surface.
 */
export function assertStrandCall(call: ToolCallRequest): ToolCallResult | null {
  if (isStrandCall(call.name)) return null;
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    data: { error: strandRefusalText(call.name) },
    durationMs: 0,
    summary: "not available in strands",
  };
}

// ── Strand round loop (model-driven tool use over the fork) ──

import { completeChatWithTools } from "../lib/openrouter-client";
import { repairToolArguments } from "../lib/tool-repair";
import type { ToolDefinition } from "../types";

export interface StrandConfig {
  /** Conversation whose fork this strand works on */
  conversationId: string;
  /** Stable name in the transcript row, e.g. "strand A" */
  label: string;
  modelId: string;
  apiKey: string;
  /** Tool definitions the strand is OFFERED (already restricted) */
  tools: ToolDefinition[];
  /** System prompt: the task + the restriction rules */
  systemPrompt: string;
  /** Wire messages (task + fork description) */
  messages: unknown[];
  signal: AbortSignal;
  /** Execute one surface-legal call against the fork (the runtime injects this) */
  execute: (call: ToolCallRequest) => Promise<ToolCallResult>;
  /** Called after each tool phase with the calls made (for strand telemetry) */
  onToolPhase?: (calls: ToolCallRequest[]) => void;
}

/**
 * Result of one strand rollout. `verified` is only ever true because a
 * run_checks call against the fork returned ok — never because the
 * model SAID so (the completion gate's rule, applied to strands).
 */
export interface StrandResult {
  label: string;
  modelId: string;
  /** The last run_checks / typecheck evidence inside the fork passed */
  verified: boolean;
  /** Prose the strand produced for the braid decision (its closing summary) */
  summary: string;
  /** Number of model rounds spent */
  rounds: number;
  /** Files the strand changed in its fork (paths) */
  touchedPaths: string[];
  /** "aborted" when the user's stop reached the strand */
  endedBy: "verified" | "cap" | "done" | "aborted" | "error";
  error?: string;
}

/**
 * Runs one strand rollout to completion. Never throws: every failure
 * becomes a result with endedBy "error" or "aborted".
 *
 * The loop is the engine's shape, miniaturized: stream-free (one
 * non-streaming completion per round), tool phases executed against
 * the fork through the injected executor, surface enforced per call,
 * stop signal honored between every step.
 */
export async function runStrand(config: StrandConfig): Promise<StrandResult> {
  const touched = new Set<string>();
  let verified = false;
  let lastSummary = "";
  let rounds = 0;

  const wireMessages: Array<Record<string, unknown>> = [
    ...(Array.isArray(config.messages) ? (config.messages as Array<Record<string, unknown>>) : []),
  ];

  while (rounds < STRAND_MAX_ROUNDS) {
    if (config.signal.aborted) {
      return finish("aborted");
    }
    rounds += 1;

    let outcome;
    try {
      outcome = await completeChatWithTools({
        apiKey: config.apiKey,
        model: config.modelId,
        messages: wireMessages as never[],
        systemPrompt: config.systemPrompt,
        tools: config.tools,
        temperature: 0.2,
        signal: config.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return finish("aborted");
      return finish("error", err instanceof Error ? err.message : "strand call failed");
    }

    const text = outcome.content?.trim() ?? "";
    if (text) lastSummary = text;

    if (outcome.toolCalls.length === 0) {
      // The model stopped talking. If its last check verified, done;
      // otherwise the strand ends unverified — no strand-level nudges.
      return finish(verified ? "verified" : "done");
    }

    // Surface enforcement, then execution against the fork.
    const calls: ToolCallRequest[] = outcome.toolCalls;
    config.onToolPhase?.(calls);
    for (const call of calls) {
      if (config.signal.aborted) return finish("aborted");
      const refused = assertStrandCall(call);
      if (refused) {
        wireMessages.push(wireToolCall(call), wireToolResult(call, refused));
        continue;
      }
      const repaired = repairToolArguments(call.arguments);
      const normalized = repaired.args
        ? { ...call, arguments: JSON.stringify(repaired.args) }
        : call;
      const result = await config.execute(normalized);
      if (call.name === "run_checks") {
        // A pass sets the flag; ANY subsequent mutation (write/edit/delete)
        // invalidates it — `verified` must describe the strand's FINAL
        // bytes, never an intermediate state. A re-run of run_checks
        // after the last edit re-earns it.
        if (result.ok) verified = true;
        else verified = false;
      } else if (
        call.name === "write_file" ||
        call.name === "edit_file" ||
        call.name === "delete_file"
      ) {
        if (result.ok) verified = false;
      }
      touched.add(normalized.name);
      wireMessages.push(wireToolCall(normalized), wireToolResult(normalized, result));
      if (config.signal.aborted) return finish("aborted");
    }
  }

  return finish(verified ? "verified" : "cap");

  function finish(endedBy: StrandResult["endedBy"], error?: string): StrandResult {
    return {
      label: config.label,
      modelId: config.modelId,
      verified,
      summary: lastSummary.slice(0, 2_000),
      rounds,
      touchedPaths: [...touched],
      endedBy,
      ...(error ? { error } : {}),
    };
  }
}

function wireToolCall(call: ToolCallRequest): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      },
    ],
  };
}

function wireToolResult(call: ToolCallRequest, result: ToolCallResult): Record<string, unknown> {
  return {
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({ ok: result.ok, data: result.data }).slice(0, 12_000),
  };
}

// ── Risk signals: when the harness even considers forking ──

export interface StrandRiskSignals {
  /** The engine's stuck counter: repeated failing calls refused this turn */
  stuckRefusals: number;
  /** Probe runs that came back with new diagnostics this turn */
  probeFailures: number;
  /** Whether the completion gate's latest verdict named a failing check */
  checkFailing: boolean;
  /** Plan progress at the stop: {total, done} */
  plan: { total: number; done: number };
  /** Rounds the main loop has already spent */
  roundsSpent: number;
}

/**
 * The risk policy. Deliberately narrow — a fork that fires on every
 * turn is a cost bug, not a capability. Any ONE signal suffices:
 *   • the model is provably stuck (repeated failing calls);
 *   • the probe found fresh diagnostics twice in one turn;
 *   • a real check failed against the current revision at the stop;
 *   • a substantial plan is stalled under halfway with rounds burning.
 */
export function shouldForkStrands(signals: StrandRiskSignals): { fork: boolean; reason: string } {
  if (signals.stuckRefusals > 0) {
    return { fork: true, reason: "the model repeated failing tool calls" };
  }
  if (signals.probeFailures >= 2) {
    return { fork: true, reason: "the mid-turn probe found new type diagnostics twice" };
  }
  if (signals.checkFailing) {
    return { fork: true, reason: "a check failed against the current revision" };
  }
  if (
    signals.plan.total >= 5 &&
    signals.plan.done / signals.plan.total < 0.4 &&
    signals.roundsSpent >= 4
  ) {
    return { fork: true, reason: "a large plan is stalled under 40% done" };
  }
  return { fork: false, reason: "" };
}

/** Max strands per fork event (main path + 2 strands = 3 concurrent rollouts max) */
export const STRAND_MAX_CONCURRENT = 2;

/**
 * Picks the models strands run on: the conversation's own model is the
 * ceiling; the caller may pass cheaper models from the catalog. The
 * strand NEVER escalates upward on its own.
 */
export function pickStrandModels(
  conversationModel: string,
  cheaperCandidates: string[],
  count: number
): string[] {
  const models: string[] = [];
  for (const candidate of cheaperCandidates) {
    if (models.length >= count) break;
    if (candidate && candidate !== conversationModel && !models.includes(candidate)) {
      models.push(candidate);
    }
  }
  while (models.length < count) models.push(conversationModel);
  return models.slice(0, count);
}
