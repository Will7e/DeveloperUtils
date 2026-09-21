// ============================================================
// Tool Repair — Make Weak Models Behave Like Good Tool-Callers
// ============================================================
// InTab runs whatever model the user picks, including free ones. The
// single biggest behavioural difference between a frontier model and a
// cheap one is not reasoning — it is tool-call hygiene:
//
//   • arguments arrive wrapped in markdown fences
//   • arguments are a bare `{...}` the provider never parsed, because
//     the model wrote the call as TEXT instead of using the API
//   • JSON is truncated mid-stream (unterminated string / open brace)
//   • the model repeats the identical failing call forever
//
// Every one of those is recoverable without a better model, and
// recovering them is exactly what a harness owns. This module is pure
// and side-effect free: the turn engine decides WHEN to repair, this
// decides HOW.
//
// Design rule: repairs are conservative and observable. A repair is
// reported (so the activity row can say "arguments repaired") rather
// than silently transforming a call the model did not intend.

import type { ToolCallRequest } from "../types";

// ── JSON extraction ─────────────────────────────────────────

/** Removes a ```lang … ``` fence when the whole text is one block */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();

  // A fence that was never closed (stream cut mid-block)
  const openOnly = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*)$/.exec(trimmed);
  if (openOnly && openOnly[1] !== undefined) return openOnly[1].trim();

  return trimmed;
}

/**
 * Finds the first balanced `{…}` / `[…]` span, ignoring braces that
 * live inside strings and respecting escapes. Returns null when the
 * text holds no complete span.
 */
export function extractBalancedSpan(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Closes a JSON value that was truncated mid-stream: terminates an
 * open string, then appends the missing closers (brackets innermost
 * first). Wrong-but-parseable beats unusable when the tail is a
 * trailing field — and the caller reports that it happened.
 */
function closeTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (!inString && stack.length === 0) return null; // nothing to fix

  let out = text;
  if (inString) out += '"';
  // Drop a dangling `"key":` or trailing comma before closing
  out = out.replace(/,\s*$/, "").replace(/:\s*$/, ":null");
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === "{" ? "}" : "]";
  }
  return out;
}

/** Applies the cheap textual fixups models actually produce */
function applyJsonFixups(text: string): string | null {
  let out = text;
  // Trailing commas before a closer
  out = out.replace(/,\s*([}\]])/g, "$1");
  // Python/JS literals that JSON rejects
  out = out
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/\bNaN\b/g, "null")
    .replace(/\bundefined\b/g, "null");
  // Single-quoted keys/values, but ONLY when no double quote exists in
  // the payload — otherwise this would mangle legitimate content.
  if (!out.includes('"')) {
    out = out.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  }
  return out === text ? null : out;
}

// ── Argument repair ─────────────────────────────────────────

export interface RepairedArguments {
  /** Parsed object, or null when the payload is unrecoverable */
  args: Record<string, unknown> | null;
  /** True when the result required more than a plain JSON.parse */
  repaired: boolean;
  /** Short, user-facing note for the activity row / turn log */
  note?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses tool arguments leniently. Order of attempts, cheapest first:
 *  1. plain JSON.parse
 *  2. strip a code fence, then parse
 *  3. slice out the balanced span, then parse
 *  4. textual fixups (trailing commas, Python literals, quotes)
 *  5. close a truncated value
 * Empty input is `{}` (tools with no required args are callable bare).
 */
export function repairToolArguments(raw: string): RepairedArguments {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { args: {}, repaired: false };

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return { args: parsed, repaired: false };
  } catch {
    /* fall through to repair */
  }

  const unfenced = stripCodeFences(trimmed);
  if (unfenced !== trimmed) {
    try {
      const parsed = JSON.parse(unfenced) as unknown;
      if (isPlainObject(parsed)) {
        return { args: parsed, repaired: true, note: "stripped code fence" };
      }
    } catch {
      /* keep going */
    }
  }

  const span = extractBalancedSpan(unfenced);
  if (span && span !== unfenced) {
    try {
      const parsed = JSON.parse(span) as unknown;
      if (isPlainObject(parsed)) {
        return { args: parsed, repaired: true, note: "extracted JSON object from surrounding text" };
      }
    } catch {
      /* keep going */
    }
  }

  const target = span ?? unfenced;

  const fixed = applyJsonFixups(target);
  if (fixed) {
    try {
      const parsed = JSON.parse(fixed) as unknown;
      if (isPlainObject(parsed)) {
        return { args: parsed, repaired: true, note: "fixed invalid JSON syntax" };
      }
    } catch {
      /* keep going */
    }
  }

  const closed = closeTruncatedJson(fixed ?? target);
  if (closed) {
    try {
      const parsed = JSON.parse(closed) as unknown;
      if (isPlainObject(parsed)) {
        return { args: parsed, repaired: true, note: "closed a truncated JSON payload" };
      }
    } catch {
      /* unrecoverable */
    }
  }

  return { args: null, repaired: false };
}

// ── Text-emitted tool calls ─────────────────────────────────

/** Argument keys models use in place of the OpenAI `arguments` field */
const ARG_KEYS = ["arguments", "parameters", "args", "input", "tool_arguments"] as const;
/** Name keys models use in place of `name` under a nested wrapper */
const NAME_KEYS = ["name", "tool", "tool_name", "function", "function_name"] as const;

/**
 * Reads a `{name, arguments}`-shaped object. Accepts the flat form
 * (`{name, arguments}`), the OpenAI-nested form (`{function:{name,…}}`)
 * and the `{tool, args}` alias. Returns null when the object is not a
 * call for a tool we know about.
 */
function readCallShape(
  value: unknown,
  known: ReadonlySet<string>
): { name: string; arguments: string } | null {
  if (!isPlainObject(value)) return null;

  // Unwrap `{function: {name, arguments}}`
  const inner = isPlainObject(value.function) ? value.function : value;

  let name: string | undefined;
  for (const key of NAME_KEYS) {
    const candidate = inner[key];
    if (typeof candidate === "string" && known.has(candidate)) {
      name = candidate;
      break;
    }
  }
  if (!name) return null;

  for (const key of ARG_KEYS) {
    const candidate = inner[key];
    if (candidate === undefined) continue;
    if (typeof candidate === "string") return { name, arguments: candidate };
    if (isPlainObject(candidate) || Array.isArray(candidate)) {
      return { name, arguments: JSON.stringify(candidate) };
    }
  }
  // A call with no argument field at all (tools with no required args)
  return { name, arguments: "{}" };
}

/** Every balanced `{…}` span in a text, capped for safety */
function balancedSpans(text: string, max = 32): string[] {
  const spans: string[] = [];
  let cursor = 0;
  while (spans.length < max) {
    const idx = text.indexOf("{", cursor);
    if (idx === -1) break;
    const slice = extractBalancedSpan(text.slice(idx));
    if (slice) {
      spans.push(slice);
      cursor = idx + slice.length;
    } else {
      cursor = idx + 1;
    }
  }
  return spans;
}

/**
 * Recovers tool calls a model emitted as PLAIN TEXT instead of through
 * the tool-call channel — the classic weak-model failure. Recognized
 * shapes, in order:
 *   - `<tool_call>…</tool_call>` / `<function_call>…</function_call>`
 *   - a fenced ```json block holding a call object
 *   - any balanced `{…}` object in the text that names a known tool
 *
 * Only calls for tools that exist are returned, so ordinary JSON in a
 * prose answer is never mistaken for an action.
 */
export function extractTextToolCalls(
  text: string,
  known: ReadonlySet<string>
): Array<{ name: string; arguments: string }> {
  if (!text.trim()) return [];
  const out: Array<{ name: string; arguments: string }> = [];
  const seen = new Set<string>();

  const push = (candidate: { name: string; arguments: string } | null) => {
    if (!candidate) return;
    const signature = `${candidate.name}\u0000${candidate.arguments}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push(candidate);
  };

  // 1) Explicit wrapper tags
  const tagRe = /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi;
  for (let m = tagRe.exec(text); m !== null; m = tagRe.exec(text)) {
    const body = m[1] ?? "";
    const parsed = repairToolArguments(body);
    if (parsed.args) {
      push(readCallShape(parsed.args, known));
      continue;
    }
    const span = extractBalancedSpan(body);
    if (span) {
      try {
        push(readCallShape(JSON.parse(span) as unknown, known));
      } catch {
        /* unparseable wrapper body */
      }
    }
  }

  // 2) Balanced JSON objects anywhere in the text (covers fenced blocks
  //    and bare JSON without a second code path)
  for (const span of balancedSpans(text)) {
    if (out.length >= 8) break;
    try {
      push(readCallShape(JSON.parse(span) as unknown, known));
    } catch {
      const repaired = repairToolArguments(span);
      if (repaired.args) push(readCallShape(repaired.args, known));
    }
  }

  return out.slice(0, 8);
}

/** Converts recovered text calls into real tool-call requests */
export function recoveredToolCalls(
  calls: Array<{ name: string; arguments: string }>,
  idPrefix = "recovered"
): ToolCallRequest[] {
  return calls.map((c, i) => ({
    id: `${idPrefix}_${i}`,
    name: c.name as ToolCallRequest["name"],
    arguments: c.arguments,
  }));
}

// ── Loop breaking ───────────────────────────────────────────

/** Stable identity for "the same call" (name + normalized args) */
export function callSignature(name: string, rawArguments: string): string {
  const repaired = repairToolArguments(rawArguments);
  let canonical = (rawArguments ?? "").trim();
  if (repaired.args) {
    const keys = Object.keys(repaired.args).sort();
    canonical = keys.map((k) => `${k}=${JSON.stringify(repaired.args![k])}`).join("&");
  }
  return `${name}\u0000${canonical}`;
}

/** What the ledger remembers about one signature in the current turn */
export interface CallLedgerEntry {
  count: number;
  /** True when the most recent execution of this call succeeded */
  ok: boolean;
  /** One-line digest of the last result (reused instead of re-running) */
  digest?: string;
  /** Serialized result text, so a reuse can be answered without a call */
  resultText?: string;
}

export type RepeatDecision =
  /** Never seen (or seen once) — execute normally */
  | { action: "execute" }
  /** Seen too often already — answer from the ledger and nudge the model */
  | { action: "reuse"; entry: CallLedgerEntry }
  /** The same call failed twice — refuse and demand a changed approach */
  | { action: "refuse"; entry: CallLedgerEntry };

/**
 * Repetition policy, in one place:
 *
 *  - the first two identical executions run for real. Two is the right
 *    allowance because a read legitimately repeats after an edit, and a
 *    write may legitimately be retried once.
 *  - the third identical SUCCESSFUL call answers from the ledger — the
 *    result cannot have changed, so re-running only burns tokens.
 *  - the third identical FAILING call is refused outright. A model that
 *    retries a broken call a third time will not fix it by retrying;
 *    it needs to read the file again, and the refusal says so.
 */
export function repeatDecision(
  entry: CallLedgerEntry | undefined,
  maxExecutions = 2
): RepeatDecision {
  if (!entry || entry.count < maxExecutions) return { action: "execute" };
  if (entry.ok) return { action: "reuse", entry };
  return { action: "refuse", entry };
}

/** Model-facing text for a reused (already-known) result */
export function reuseResultText(entry: CallLedgerEntry): string {
  const body = entry.resultText ?? entry.digest ?? "(no longer available)";
  return (
    "This exact call was already run in this turn and the workspace has not changed since — " +
    "here is the same result again instead of re-running it:\n\n" +
    body +
    "\n\nDo not repeat this call. Use the result, or change the arguments (different path, " +
    "narrower window, different query) if you need something else."
  );
}

/** Model-facing corrective text when a broken call is repeated */
export function refuseResultText(entry: CallLedgerEntry, name: string): string {
  return (
    `\`${name}\` was called with these exact arguments ${entry.count + 1} times and it failed ` +
    `every time — repeating it cannot succeed. Last error: ${entry.digest ?? "(unknown)"}.\n\n` +
    "Change your approach: re-read the file (or region) to get the current exact text, then " +
    "issue a corrected call. If the failure is environmental (network, permissions), report it " +
    "to the user instead of retrying."
  );
}

/** Model-facing nudge when a model answered with prose but tools were available */
export function noToolCallNudge(recoveredNames: string[]): string {
  const list = recoveredNames.map((n) => `\`${n}\``).join(", ");
  return (
    `Your previous message described tool calls in text (${list}) instead of calling them. ` +
    "They have been executed for you this time. Next time, emit real tool calls — a call inside " +
    "prose is not executed and the user sees an unfinished turn."
  );
}
