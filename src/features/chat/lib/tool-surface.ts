// ============================================================
// Tool Surface — A Tool You Were Not Offered Is Not A Tool
// ============================================================
// Two rules used to disagree, and the gap between them is a bug that reached a
// user: the prompt DESCRIBED all fourteen app tools on every turn, the schema
// list OFFERED only the ones the profile kept, and the executor ACCEPTED any
// registered name. So a free model — sent a lean surface with `http_write`
// withheld — was told about `http_write` in prose, called it, and the engine
// ran it. Plan mode was the only place that checked whether a tool had actually
// been offered.
//
// This module is that check, in one place, plus the sentence that makes a
// refusal useful rather than merely correct: WHICH alternative was offered, and
// how to call it. A refusal that only says no teaches the model to try again;
// a refusal that names the sibling ends the episode.
//
// It also carries the corrective hint attached to a REPEATED failure. The first
// schema error is a fact; the second identical one means the raw error was not
// enough, which is exactly when the tool's own contract (what it is for, what it
// is confused with, the mistake people make with it) is the most useful thing
// the harness could say.

import type { ToolCallResult } from "../types";
import { contractFor } from "./tool-contracts";
import { isValidToolName } from "./tool-registry";

/**
 * How many alternatives a refusal names when it has no sibling to point at.
 *
 * Small on purpose: a list of thirty tool names is a schema dump, and the model
 * already has the real surface one message earlier.
 */
const ALTERNATIVE_LIMIT = 6;

/**
 * The message for a call to a tool that was NOT offered this turn.
 *
 * Returns null when the tool WAS offered (nothing to enforce) or when the name
 * is not in the registry at all — an unknown name gets the registry's own
 * "Unknown tool" message, which is a different mistake with a different fix.
 */
export function withheldRefusal(
  name: string,
  offered: ReadonlySet<string>
): string | null {
  if (offered.has(name)) return null;
  if (!isValidToolName(name)) return null;

  const contract = contractFor(name);
  const parts: string[] = [
    `Tool "${name}" is real, but it was NOT in the tool list for this turn — so it cannot be called here, and calling it again will not change that.`,
  ];

  const sibling = contract?.insteadOf?.tool;
  if (sibling && offered.has(sibling)) {
    const discriminator = contract?.insteadOf?.discriminator ?? "it is the tool available here";
    parts.push(`Use \`${sibling}\` instead — ${discriminator}.`);
    const how = contractFor(sibling)?.how;
    if (how) parts.push(how);
  } else {
    const alternatives = [...offered].slice(0, ALTERNATIVE_LIMIT);
    parts.push(
      `What you can call this turn: ${alternatives.map((a) => `\`${a}\``).join(", ")}${
        offered.size > ALTERNATIVE_LIMIT ? ", …" : ""
      }.`
    );
  }

  return parts.join(" ");
}

/**
 * Adds the tool's own contract to a FAILED result that is a repeat.
 *
 * Called with results the ledger has already seen once: the second identical
 * failure means the error text alone did not carry the model to the fix, so the
 * contract's `how`, its sibling and its known misuse are appended to the payload
 * the model reads next.
 *
 * The payload is copied rather than mutated, and a payload that is not an object
 * gets its own `hint` field beside a stringified error, so the model always finds
 * the advice in the same key.
 */
export function withContractHint(result: ToolCallResult): ToolCallResult {
  if (result.ok) return result;
  const hint = contractFor(result.name);
  if (!hint) return result;

  const advice = [
    `This exact call has already failed once this turn, so repeating it will not work.`,
    `What this tool is for: ${hint.how}`,
    hint.insteadOf
      ? `If that is not what you meant, \`${hint.insteadOf.tool}\` is a different tool — ${hint.insteadOf.discriminator}.`
      : "",
    hint.misuse ? `Common mistake: ${hint.misuse}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const payload = result.data;
  const next =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), hint: advice }
      : { error: typeof payload === "string" ? payload : "the call failed", hint: advice };

  return { ...result, data: next };
}

/** Short note for the activity row: arguments repaired before execution */
export function argumentRepairNote(notes: readonly string[]): string {
  if (notes.length === 0) return "";
  return notes.length === 1
    ? `arguments repaired — ${notes[0]}`
    : `arguments repaired (${notes.length}) — ${notes[0]}`;
}
