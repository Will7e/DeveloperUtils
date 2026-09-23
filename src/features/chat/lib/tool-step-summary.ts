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

  // ── App tools ──
  // A run, a comparison or a lookup changes no file, so without these the
  // row is a bare verb and the user has to open it to learn anything. Each
  // fact answers "what happened?" in a glance: which language ran and
  // whether it exited clean, how many hits came back, how big the board is,
  // which tool was opened.
  const language = typeof payload.language === "string" ? payload.language : null;
  const exitCode = num(payload.exitCode);
  if (language && exitCode !== null) facts.push(`${language} exit ${exitCode}`);
  else if (language) facts.push(language);

  if (Array.isArray(payload.matches)) {
    const total = num(payload.totalMatches) ?? payload.matches.length;
    facts.push(`${total} match${total === 1 ? "" : "es"}`);
  }

  const nodes = num(payload.nodes);
  const edges = num(payload.edges);
  if (nodes !== null && edges !== null) facts.push(`${nodes} nodes`);

  if (typeof payload.target === "string" && payload.opened === true) {
    facts.push(String(payload.target));
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
