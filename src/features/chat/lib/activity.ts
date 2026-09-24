// ============================================================
// Activity — What The Agent Is Doing Right Now
// ============================================================
// A long agent turn with nothing on screen is indistinguishable from a hung one.
// The transcript answers "what happened", in order, at the end; it cannot answer
// "what is happening", which is the question a person asks every few seconds
// while watching. That gap is what this module fills: one line naming the
// current phase, the tool being used and what it is being used ON.
//
// The facts already exist and none of them are new: reasoning arrives as
// `streamingReasoning`, prose as `streamingContent`, and a tool call is visible
// the moment its arguments are assembled and pending until its result pairs
// back. So this is a REDUCTION over state the page already holds — no store
// fields, no events, no backend — and it is pure so the phase table can be
// tested rather than observed in a running turn.
//
// Two deliberate silences:
//
//   • Writing is not announced the way tools are. Once the model is emitting
//     prose there is nothing to name, so the phase is `writing` and the target is
//     empty rather than a guess at what the paragraph is about.
//   • A queued message changes nothing here. It is waiting for a round boundary,
//     which is the composer's story, and folding it in would make the rail
//     describe the queue instead of the work.

import type { ActivityPhase } from "./tool-labels";
import { toolActivityVerb, toolPhase } from "./tool-labels";
import type { AgentPlan, ChatMessage, ToolCallRequest } from "../types";

/** The phases a rail can show, re-exported for callers that only import this */
export type { ActivityPhase };

export interface ActivityInput {
  /** A turn is streaming (in this conversation) */
  isStreaming: boolean;
  /** The stream dropped and a resume is in flight */
  reconnecting: boolean;
  /** Live assistant prose */
  streamingContent: string;
  /** Live chain-of-thought, when the model emits one */
  streamingReasoning: string;
  /** The conversation's messages, oldest first */
  messages: readonly ChatMessage[];
  /** The conversation's plan, when the model published one */
  plan?: AgentPlan;
  /** True while the turn is parked on a question for the user */
  waitingForUser?: boolean;
  /** True while a user-initiated "Run checks" is in flight */
  runningChecks?: boolean;
}

export interface Activity {
  phase: ActivityPhase;
  /** Present participle for the phase, e.g. "Editing" */
  verb: string;
  /** What it is acting on — a path, a query, a URL — or "" */
  target: string;
  /** 1-based position of the pending call within its step group (0 when none) */
  stepIndex: number;
  /** How many calls that step group holds (0 when none) */
  stepTotal: number;
  /**
   * Identity of the current activity. A caller keys its elapsed-time clock on
   * this: two renders with the same key are the SAME phase continuing, and a
   * different key means the clock starts again. A timestamp would have to come
   * from somewhere, and the store does not record one per phase — so identity is
   * the honest thing to hand out.
   */
  key: string;
  /** The call's start time when the transcript knows it, else null */
  since: number | null;
  /** True when the agent is doing something, false when it is at rest */
  busy: boolean;
}

const IDLE: Activity = {
  phase: "idle",
  verb: "",
  target: "",
  stepIndex: 0,
  stepTotal: 0,
  key: "idle",
  since: null,
  busy: false,
};

interface PendingCall {
  message: ChatMessage;
  call: ToolCallRequest;
  stepIndex: number;
  stepTotal: number;
}

/**
 * The call whose result has not come back yet, in the most recent step group.
 *
 * Mirrors the pairing rule the transcript uses (services/agent-actions returns
 * results in call order, and ToolCallBlock stops pairing at the next message
 * carrying calls): within one group, results answer calls in order, and the
 * first unanswered call is the one running.
 */
function pendingCall(messages: readonly ChatMessage[]): PendingCall | null {
  let lastCallsIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.toolCalls) {
      lastCallsIdx = i;
      break;
    }
  }
  if (lastCallsIdx < 0) return null;

  const message = messages[lastCallsIdx];
  const calls = message?.toolCalls?.calls ?? [];
  if (calls.length === 0) return null;

  const answered = new Set<string>();
  for (let i = lastCallsIdx + 1; i < messages.length; i++) {
    const next = messages[i];
    if (!next) break;
    if (next.toolCalls) break; // next step group — stop pairing
    if (next.toolResult) answered.add(next.toolResult.callId);
  }

  const index = calls.findIndex((call) => !answered.has(call.id));
  if (index < 0) return null;
  const call = calls[index];
  if (!call) return null;
  return { message: message!, call, stepIndex: index + 1, stepTotal: calls.length };
}

/**
 * The one thing in a tool call worth naming.
 *
 * Ordered by how specific each field is: a path is the thing a person wants to
 * see, then a query, then a URL or command. Reading the raw arguments would put
 * `{"subtree":"src"}` on screen; naming nothing would leave the rail as vague as
 * a spinner. Values are trimmed so a long inline command cannot push the phase
 * off the line — the rail clips, it does not grow.
 */
export function targetOf(argumentsJson: string): string {
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    args = parsed as Record<string, unknown>;
  } catch {
    // A half-assembled argument string is the normal state for a moment during
    // streaming; it is not an error worth showing.
    return "";
  }

  const stringAt = (key: string): string => {
    const value = args[key];
    return typeof value === "string" ? value.trim() : "";
  };

  const path = stringAt("path") || stringAt("file");
  if (path) return path;
  const paths = args.paths;
  if (Array.isArray(paths) && paths.length > 0) {
    const first = paths.filter((p): p is string => typeof p === "string");
    if (first.length === 1) return first[0]!;
    if (first.length > 1) return `${first[0]} +${first.length - 1} more`;
  }
  const query = stringAt("query") || stringAt("pattern") || stringAt("q");
  if (query) return `“${query}”`;
  const url = stringAt("url");
  if (url) return url;
  const command = stringAt("command") || stringAt("code");
  if (command) return command;
  const subtreeNode = stringAt("subtree");
  if (subtreeNode) return `${subtreeNode}/`;
  // MCP and app-surface calls are named by what they invoke, not by a path.
  const named = stringAt("name") || stringAt("tool") || stringAt("action");
  return named;
}

/**
 * What the agent is doing right now.
 *
 * Ordered by specificity, not by recency of the input: an in-flight tool call is
 * the most concrete fact available (it names a file), a reconnect is a fact about
 * the transport, and reasoning or prose is the fallback for the moments between
 * calls. Getting this order wrong is how a rail says "Thinking…" while a diff is
 * being written.
 */
export function deriveActivity(input: ActivityInput): Activity {
  if (input.runningChecks) {
    return {
      phase: "verifying",
      verb: "Running checks",
      target: "",
      stepIndex: 0,
      stepTotal: 0,
      key: "checks",
      since: null,
      busy: true,
    };
  }

  if (input.reconnecting) {
    return {
      phase: "running",
      verb: "Reconnecting",
      target: "",
      stepIndex: 0,
      stepTotal: 0,
      key: "reconnecting",
      since: null,
      busy: true,
    };
  }

  // A parked turn is not streaming, but it is emphatically not finished either:
  // without this the rail would go dark exactly while the agent is waiting for
  // the reply it cannot proceed without.
  if (input.waitingForUser) {
    return {
      phase: "waiting",
      verb: "Waiting for your answer",
      target: "",
      stepIndex: 0,
      stepTotal: 0,
      key: "waiting",
      since: null,
      busy: true,
    };
  }

  if (!input.isStreaming) return IDLE;

  const pending = pendingCall(input.messages);
  if (pending) {
    const target = targetOf(pending.call.arguments);
    return {
      phase: toolPhase(pending.call.name),
      verb: toolActivityVerb(pending.call.name),
      target,
      stepIndex: pending.stepIndex,
      stepTotal: pending.stepTotal,
      key: `tool:${pending.call.id}`,
      since: pending.message.timestamp || null,
      busy: true,
    };
  }

  // Reasoning with no prose yet: the model is thinking, and on a reasoning model
  // this is the phase that can last the longest. Saying "Thinking…" is the whole
  // point of the rail here.
  if (input.streamingReasoning.trim() !== "" && input.streamingContent === "") {
    return {
      phase: "thinking",
      verb: "Thinking",
      target: "",
      stepIndex: 0,
      stepTotal: 0,
      key: "thinking",
      since: null,
      busy: true,
    };
  }

  if (input.streamingContent !== "") {
    return {
      phase: "writing",
      verb: "Writing the reply",
      target: "",
      stepIndex: 0,
      stepTotal: 0,
      key: "writing",
      since: null,
      busy: true,
    };
  }

  // Streaming with nothing arrived yet — the first tokens of a turn. A plan the
  // model is working through is worth naming here, because "step 2 of 5" is more
  // useful than an ellipsis.
  const plan = input.plan;
  const activeStep = plan?.steps?.find((step) => step.status === "active");
  return {
    phase: "thinking",
    verb: activeStep ? "Working the plan" : "Thinking",
    target: activeStep?.text ?? "",
    stepIndex: 0,
    stepTotal: plan?.steps?.length ?? 0,
    key: activeStep ? `plan:${activeStep.id}` : "thinking",
    since: null,
    busy: true,
  };
}

/**
 * Whether a turn just ENDED, so a rail can hold the result on screen instead of
 * vanishing the instant the last token lands.
 *
 * Derived from the same fact the rail already watches (busy now, idle a moment
 * ago) rather than from a completion event, because a completion event is
 * something the rail would have to subscribe to and could miss during a reload.
 */
export function justFinished(previous: Activity, next: Activity): boolean {
  return previous.busy && !next.busy;
}
