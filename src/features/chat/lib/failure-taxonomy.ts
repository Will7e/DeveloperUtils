// ============================================================
// Failure Taxonomy — Why A Turn Went Wrong, Counted
// ============================================================
// "The agent failed" is not a fact anybody can act on. What can be acted on is
// WHICH way it failed, how often, and whether the fix worked — and the reason
// this file exists is that the alternative is what we had: a user reports a
// transcript, someone diagnoses it by hand, the diagnosis is acted on, and
// nothing measures whether it recurs.
//
// So every failure this harness knows how to cause gets a name, a rule that
// recognises it in a stored transcript (no model, no network — the transcript
// is the whole input), and the fix that addresses it. The counts feed the
// scorecard; the findings feed the eval drafter (evals/golden-cases.ts), where
// a real failure becomes a permanent case.
//
// The rules are deliberately CONSERVATIVE. A false positive here is worse than
// a miss: it sends someone to fix a mechanism that is working, and it teaches
// whoever reads the report to distrust the numbers. So each rule fires only on
// evidence the transcript actually contains:
//
//   • a validation error we ourselves wrote, not "the call looked wrong";
//   • the same call twice with the same arguments, not two similar calls;
//   • a failure whose tool contract names a sibling the turn then used, not a
//     guess about which tool would have been better;
//   • a silent end after a failure, checked against harness-authored notices so
//     the harness is never counted as the model going quiet.
//
// Pure: conversations in, findings out. No store, no clock, no I/O.

import type { ChatConversation, ChatMessage, ToolCallRequest, ToolName } from "../types";
import { contractFor } from "./tool-contracts";
import { COMPLETION_NUDGE_PREFIX, TOOL_LIMIT_NOTICE } from "./harness-notices";

export type FailureKind =
  /** The model named a tool that does not exist (a typo or an invention) */
  | "unknown-tool"
  /** A tool the turn did not offer was called — the surface said no */
  | "withheld-tool"
  /** A call we rejected on its arguments (missing, wrong type, over a cap) */
  | "schema-failure"
  /** The same call, with the same arguments, was made twice in one turn */
  | "repeated-call"
  /** A failed call whose contract names a sibling the turn also reached for */
  | "wrong-sibling"
  /** The turn ended on prose without acknowledging a failed call */
  | "unanswered-failure"
  /** Five or more single-file reads and no batched read or search */
  | "over-read"
  /** It asked a question before looking at anything, then looked anyway */
  | "ask-before-looking"
  /** Source was written and nothing was run to check it */
  | "unverified-writes"
  /** The turn used up its rounds with work still open */
  | "round-exhaustion";

export const FAILURE_KINDS: readonly FailureKind[] = [
  "unknown-tool",
  "withheld-tool",
  "schema-failure",
  "repeated-call",
  "wrong-sibling",
  "unanswered-failure",
  "over-read",
  "ask-before-looking",
  "unverified-writes",
  "round-exhaustion",
];

/** How the report names each one, in the words a reader already uses */
export const FAILURE_LABEL: Record<FailureKind, string> = {
  "unknown-tool": "Invented tool name",
  "withheld-tool": "Called a withheld tool",
  "schema-failure": "Arguments rejected",
  "repeated-call": "Repeated a failed call",
  "wrong-sibling": "Chose the wrong sibling",
  "unanswered-failure": "Went quiet after a failure",
  "over-read": "Read one file at a time",
  "ask-before-looking": "Asked before looking",
  "unverified-writes": "Wrote code without running anything",
  "round-exhaustion": "Ran out of rounds",
};

/**
 * The mechanism that addresses each failure, named here so a report points at
 * something rather than at a suspicion. These are the same mechanisms the
 * contract table and the turn engine implement.
 */
export const FAILURE_FIX: Record<FailureKind, string> = {
  "unknown-tool": "the registry's unknown-name error + the tool list in the prompt",
  "withheld-tool": "lib/tool-surface.ts withheldRefusal (names the sibling that IS offered)",
  "schema-failure": "lib/arg-coercion.ts repairs + validateToolCall's precise message",
  "repeated-call": "lib/tool-repair.ts repeatDecision + the contract hint on the second failure",
  "wrong-sibling": "the contract's insteadOf discriminator, generated into the prompt bullet",
  "unanswered-failure": "lib/completion-gate.ts + the failed-check reason",
  "over-read": "read_files (one call, many paths) and the working-discipline block",
  "ask-before-looking": "lib/tool-contracts.ts autonomy: ask only what reading cannot answer",
  "unverified-writes": "the verification ladder (run_checks → run_command → verify_with_ci)",
  "round-exhaustion": "a smaller surface (tool profiles) + a plan the model can see",
};

export interface FailureFinding {
  kind: FailureKind;
  /** 1-based index of the user turn inside the conversation */
  turn: number;
  /** One line naming what happened, in the report's words */
  detail: string;
  /** The raw evidence: tool names, paths, the observed error text */
  evidence: string[];
}

export interface TaxonomyCounts {
  total: number;
  /** Every kind, including the ones at zero, so a report never omits a row */
  byKind: Record<FailureKind, number>;
  /** How many turns were examined (the denominator the shares use) */
  turns: number;
}

// ── Rules ────────────────────────────────────────────────────

/**
 * A validation message this harness writes (registry or executor).
 *
 * The optional backslashes are load-bearing: a failed result is serialized as
 * `{ "error": ... }`, so the TRANSCRIPT text of a validation failure reads
 * `Argument \"headers\" must be of type object, got string.` with the quotes
 * escaped. A pattern written for the raw message matches nothing in the place
 * this module reads, which is the quietest possible way for a metric to be
 * wrong forever.
 */
const ARGUMENT_ERROR_RE = /Argument \\?"[^"\\]{1,80}\\?" (?:must|has|exceeds|is not|is required)/;
/** The surface refusal from lib/tool-surface.ts */
const WITHHELD_RE = /was NOT in the tool list for this turn/;
/** The registry's own miss */
const UNKNOWN_TOOL_RE = /^Unknown tool: /;

/** Words that show the model TOLD the user something failed */
const ACKNOWLEDGEMENT_RE =
  /\b(fail|failed|error|cannot|can't|could not|couldn't|unable|refus|did not run|didn't run|was not run|wasn't run|not run|timed out|no such|missing)\b/i;

/** Reads that count as "looking" before asking */
const LOOKING_TOOLS = new Set<ToolName>([
  "get_repo_overview",
  "list_repo_files",
  "find_files",
  "read_file",
  "read_files",
  "search_code",
  "search_workspace",
  // The GitHub reads count for the same reason the repository ones do: "why is
  // CI red?" and "what did the reviewer say?" are questions with an answer the
  // agent can fetch, so asking the user instead is the same failure — and it is
  // the failure this file exists to count.
  "list_issues",
  "read_issue",
  "list_pull_requests",
  "read_pull_request",
  "read_ci_logs",
]);

/** A batched read or a search — the alternative to reading file by file */
const BATCH_TOOLS = new Set<ToolName>(["read_files", "search_workspace", "search_code", "find_files"]);

const WRITE_TOOLS = new Set<ToolName>(["write_file", "edit_file", "delete_file"]);

/** Tools that prove something ran */
const VERIFY_TOOLS = new Set<ToolName>(["run_checks", "run_command", "verify_with_ci"]);

/** Paths whose change needs no execution to be trusted */
const NON_SOURCE_RE = /\.(?:md|mdx|txt|json|ya?ml|toml|lock|gitignore|csv|svg|png|jpg|jpeg|gif|ico)$/i;

/** At or above this many single-file reads, batching was the better call */
const OVER_READ_THRESHOLD = 5;

/** Arguments, normalised so key order cannot hide a repeat */
function stableArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      return JSON.stringify(entries);
    }
    return JSON.stringify(parsed);
  } catch {
    return raw.trim();
  }
}

function resultText(message: ChatMessage): string {
  const content = message.toolResult?.content ?? "";
  return content;
}

function targetOf(call: ToolCallRequest): string | null {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const path = args.path;
    return typeof path === "string" ? path : null;
  } catch {
    return null;
  }
}

interface TurnSlice {
  index: number;
  calls: ToolCallRequest[];
  /** Results paired to their call by id, in call order */
  results: Array<{ call: ToolCallRequest; ok: boolean; text: string }>;
  /** Assistant prose messages (no tool calls) that belong to this turn */
  prose: string[];
}

/** Splits a transcript into user turns, in order */
export function splitTurns(messages: readonly ChatMessage[]): TurnSlice[] {
  const turns: TurnSlice[] = [];
  let current: TurnSlice | null = null;

  for (const message of messages) {
    if (message.hidden) continue;
    const isToolMessage = message.toolCalls !== undefined || message.toolResult !== undefined;
    if (message.role === "user" && !isToolMessage) {
      current = { index: turns.length + 1, calls: [], results: [], prose: [] };
      turns.push(current);
      continue;
    }
    // A transcript may open on a tool row (a resumed turn): make a turn for it
    // rather than dropping the evidence.
    if (!current) {
      current = { index: turns.length + 1, calls: [], results: [], prose: [] };
      turns.push(current);
    }
    if (message.toolCalls) current.calls.push(...message.toolCalls.calls);
    if (message.toolResult) {
      const call = current.calls.find((c) => c.id === message.toolResult!.callId);
      if (call) {
        current.results.push({ call, ok: message.toolResult.ok, text: resultText(message) });
      }
    }
    if (message.role === "assistant" && !message.toolCalls) current.prose.push(message.content);
  }

  return turns;
}

/** True for a message the HARNESS wrote, which must never count as the model */
function isHarnessProse(text: string): boolean {
  return text.includes(COMPLETION_NUDGE_PREFIX) || text.includes(TOOL_LIMIT_NOTICE);
}

/**
 * Classifies one turn. Exported so a single transcript section can be explained
 * without scoring a whole conversation.
 */
export function classifyTurn(turn: TurnSlice): FailureFinding[] {
  const findings: FailureFinding[] = [];
  const push = (kind: FailureKind, detail: string, evidence: string[]): void => {
    findings.push({ kind, turn: turn.index, detail, evidence });
  };

  // ── Per-call failures ──
  const failedCalls: Array<{ call: ToolCallRequest; text: string }> = [];
  for (const result of turn.results) {
    if (result.ok) continue;
    failedCalls.push({ call: result.call, text: result.text });
    if (WITHHELD_RE.test(result.text)) {
      push(
        "withheld-tool",
        `called \`${result.call.name}\`, which this turn's surface did not offer`,
        [result.call.name, result.text.slice(0, 240)]
      );
    } else if (UNKNOWN_TOOL_RE.test(result.text)) {
      push("unknown-tool", `called \`${result.call.name}\`, which does not exist`, [
        result.call.name,
        result.text.slice(0, 200),
      ]);
    } else if (ARGUMENT_ERROR_RE.test(result.text)) {
      push("schema-failure", `\`${result.call.name}\` was rejected on its arguments`, [
        result.call.name,
        result.text.slice(0, 240),
      ]);
    }
  }

  // ── Repeated call: same tool, same arguments, twice in one turn ──
  const seen = new Map<string, ToolCallRequest[]>();
  for (const call of turn.calls) {
    const key = `${call.name}\u0000${stableArguments(call.arguments)}`;
    const list = seen.get(key);
    if (list) list.push(call);
    else seen.set(key, [call]);
  }
  const repeats = [...seen.values()].filter((list) => list.length > 1);
  if (repeats.length > 0) {
    const worst = repeats[0]!;
    push(
      "repeated-call",
      `\`${worst[0]!.name}\` was called ${worst.length} times with identical arguments`,
      [worst[0]!.name, stableArguments(worst[0]!.arguments).slice(0, 200)]
    );
  }

  // ── Wrong sibling: a failed call whose contract names a tool the turn used ──
  const calledNames = new Set(turn.calls.map((c) => c.name));
  for (const failure of failedCalls) {
    const sibling = contractFor(failure.call.name)?.insteadOf?.tool;
    if (!sibling) continue;
    const usedSibling = calledNames.has(sibling);
    const mentioned = failure.text.includes(sibling);
    if (!usedSibling && !mentioned) continue;
    push(
      "wrong-sibling",
      `\`${failure.call.name}\` failed and \`${sibling}\` was the tool for the job${
        usedSibling ? " — the turn reached for it afterwards" : " — the refusal had to name it"
      }`,
      [failure.call.name, sibling]
    );
  }

  // ── Went quiet after a failure ──
  const lastProse = turn.prose[turn.prose.length - 1];
  if (failedCalls.length > 0 && lastProse && !isHarnessProse(lastProse) && !ACKNOWLEDGEMENT_RE.test(lastProse)) {
    push(
      "unanswered-failure",
      `ended the turn without telling the user that ${failedCalls.length} call(s) failed`,
      [...new Set(failedCalls.map((f) => f.call.name))]
    );
  }

  // ── Read one file at a time ──
  const singleReads = turn.calls.filter((c) => c.name === "read_file");
  const batched = turn.calls.some((c) => BATCH_TOOLS.has(c.name));
  if (singleReads.length >= OVER_READ_THRESHOLD && !batched) {
    push(
      "over-read",
      `${singleReads.length} separate \`read_file\` calls with no batched read or search`,
      singleReads.map((c) => targetOf(c) ?? "(unknown path)")
    );
  }

  // ── Asked before looking ──
  const askIndex = turn.calls.findIndex((c) => c.name === "ask_user");
  if (askIndex >= 0) {
    const lookedBefore = turn.calls.slice(0, askIndex).some((c) => LOOKING_TOOLS.has(c.name));
    const lookedAfter = turn.calls.slice(askIndex + 1).some((c) => LOOKING_TOOLS.has(c.name));
    if (!lookedBefore && lookedAfter) {
      push(
        "ask-before-looking",
        "asked the user a question before reading anything, then found the answer by reading",
        [...new Set(turn.calls.slice(askIndex + 1).filter((c) => LOOKING_TOOLS.has(c.name)).map((c) => c.name))]
      );
    }
  }

  // ── Wrote code, ran nothing ──
  const wrotePaths = turn.calls
    .filter((c) => WRITE_TOOLS.has(c.name))
    .map((c) => targetOf(c))
    .filter((p): p is string => typeof p === "string");
  const sourceWrites = wrotePaths.filter((p) => !NON_SOURCE_RE.test(p));
  const ranSomething = turn.calls.some((c) => VERIFY_TOOLS.has(c.name));
  if (sourceWrites.length > 0 && !ranSomething) {
    push(
      "unverified-writes",
      `${sourceWrites.length} source file(s) changed and nothing was run to check them`,
      sourceWrites.slice(0, 8)
    );
  }

  // ── Ran out of rounds ──
  const exhausted = turn.prose.find((text) => text.includes(TOOL_LIMIT_NOTICE));
  if (exhausted) {
    push("round-exhaustion", `hit the tool-use limit with ${turn.calls.length} calls made`, [
      `${turn.calls.length} calls`,
    ]);
  }

  return findings;
}

/** One conversation's findings, in turn order */
export function classifyConversation(conversation: ChatConversation): FailureFinding[] {
  const findings: FailureFinding[] = [];
  for (const turn of splitTurns(conversation.messages)) findings.push(...classifyTurn(turn));
  return findings;
}

/** Rolls findings up into the numbers a report quotes */
export function taxonomyCounts(
  conversations: readonly ChatConversation[],
  findings?: readonly FailureFinding[]
): TaxonomyCounts {
  const all = findings ?? conversations.flatMap((c) => classifyConversation(c));
  const byKind = Object.fromEntries(FAILURE_KINDS.map((k) => [k, 0])) as Record<FailureKind, number>;
  for (const finding of all) byKind[finding.kind] += 1;
  const turns = conversations.reduce((sum, c) => sum + splitTurns(c.messages).length, 0);
  return { total: all.length, byKind, turns };
}

/** True when the finding names a mechanism that could be changed */
export function isActionable(kind: FailureKind): boolean {
  return FAILURE_FIX[kind].length > 0;
}

/**
 * The report, as text.
 *
 * Ordered by count rather than by severity because the number is the argument:
 * the top row is the next thing worth fixing, and the fix is printed beside it
 * so the reader does not have to hold the taxonomy in their head.
 */
export function formatFailureReport(counts: TaxonomyCounts, findings: readonly FailureFinding[]): string {
  if (counts.total === 0) {
    return `No classified failures across ${counts.turns} turn(s) — nothing in ${FAILURE_KINDS.length} categories to fix.`;
  }
  const ranked = FAILURE_KINDS.filter((k) => counts.byKind[k] > 0).sort(
    (a, b) => counts.byKind[b] - counts.byKind[a] || a.localeCompare(b)
  );
  const lines = ranked.map(
    (kind) => `  ${FAILURE_LABEL[kind].padEnd(32)} ${String(counts.byKind[kind]).padStart(3)}   → ${FAILURE_FIX[kind]}`
  );
  const detail = findings.slice(0, 5).map((f) => `  turn ${f.turn}: ${f.detail}`);
  return [
    `Classified failures — ${counts.total} across ${counts.turns} turn(s)`,
    "",
    ...lines,
    "",
    "Most recent:",
    ...detail,
  ].join("\n");
}
