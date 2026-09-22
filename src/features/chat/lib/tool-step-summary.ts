// ============================================================
// Tool Step Summary — Reading a Result Back for the Transcript
// ============================================================
// A tool result reaches the transcript as the serialized string the
// model saw. The activity rows want structured facts out of it: which
// file, added/modified/deleted, how many additions and deletions,
// whether it failed and why.
//
// Two things make that less trivial than JSON.parse:
//
//   1. results from repo-reading tools arrive wrapped in
//      <untrusted-content> tags (lib/untrusted.ts), and
//   2. an old or hand-edited transcript may hold anything at all.
//
// Both must degrade to "no facts" rather than throw: a thrown error
// here would take out the whole transcript, not one row.

export type ToolResultPayload = Record<string, unknown>;

/**
 * Parses one tool-result content string. Returns null for the empty,
 * non-object, and malformed cases, including untrusted-wrapped text
 * whose JSON body is unusable.
 */
export function readToolResultPayload(content: string | undefined): ToolResultPayload | null {
  if (typeof content !== "string") return null;
  let text = content.trim();
  if (text.startsWith("<untrusted-content")) {
    const end = text.lastIndexOf("</untrusted-content>");
    if (end > 0) text = text.slice(text.indexOf(">") + 1, end).trim();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is ToolResultPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ToolStepSummary {
  additions: number;
  deletions: number;
  /** Short inline facts: file status, replacement count, failure text */
  facts: string[];
}

/**
 * Facts for one activity row. A row is a glance, not a report, so at
 * most two are returned — but a FAILURE's message is one of them
 * whenever the payload carries one: a red row that does not say why
 * is worse than no row at all, and the caller reads the last fact as
 * the failure text.
 */
export function summarizeToolStep(payload: ToolResultPayload | null): ToolStepSummary {
  if (!payload) return { additions: 0, deletions: 0, facts: [] };
  const facts: string[] = [];

  const status = typeof payload.status === "string" ? payload.status : null;
  if (status === "added") facts.push("new file");
  else if (status === "deleted") facts.push("removed");
  else if (status === "modified") facts.push("modified");

  const replacements = num(payload.replacements);
  if (replacements !== null && replacements > 1) facts.push(`${replacements}×`);

  const lineDelta = num(payload.lineDelta);
  if (replacements !== null && lineDelta !== null && lineDelta !== 0) {
    const size = Math.abs(lineDelta);
    facts.push(`${lineDelta > 0 ? "+" : "−"}${size} line${size === 1 ? "" : "s"}`);
  }

  const error = typeof payload.error === "string" ? payload.error.trim() : "";

  return {
    additions: num(payload.additions) ?? 0,
    deletions: num(payload.deletions) ?? 0,
    facts: error ? [...facts.slice(0, 1), error] : facts.slice(0, 2),
  };
}

/** Total change counts across a set of step summaries */
export function sumStepChanges(summaries: readonly ToolStepSummary[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const summary of summaries) {
    additions += summary.additions;
    deletions += summary.deletions;
  }
  return { additions, deletions };
}
