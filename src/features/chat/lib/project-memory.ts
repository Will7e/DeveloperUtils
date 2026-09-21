// ============================================================
// Project Memory — Durable Facts That Outlive a Conversation
// ============================================================
// The rolling summary (context/compactor + services/compaction) is
// working memory: it dies with the conversation. What a coding agent
// actually keeps rediscovering are the STABLE facts about a repository —
// how the tests run, which module owns which concern, the quirk that
// cost an hour last time. Re-discovery is pure waste, and it is waste
// this harness can eliminate without training anything.
//
// Memory lives in a file in the repository itself (`.intab/memory.md`):
//
//   • it travels with the repo, so it is shared by a team, not trapped
//     in one user's browser profile;
//   • it reaches GitHub only through the normal push gate, so the user
//     reviews every recorded fact like any other change;
//   • it survives a conversation being deleted, a model switch, and a
//     different machine.
//
// Deliberately narrow: durable, repo-specific, factual. Not task
// progress, not user preferences, not secrets.
//
// Pure and store-free: the executor (services/agent-actions.ts) owns the
// workspace write; this module owns the format.

/** Where the memory lives, relative to the repository root */
export const MEMORY_PATH = ".intab/memory.md";

/** One fact is bounded so a runaway agent cannot rewrite the repo */
export const MEMORY_FACT_MAX_CHARS = 400;
/** Cap on remembered facts; oldest entries are dropped past this */
export const MEMORY_MAX_FACTS = 200;

export const MEMORY_HEADER = [
  "# Project memory",
  "",
  "Durable, repository-specific facts recorded by the InTab agent so later sessions",
  "stop rediscovering them: how to run and verify things, conventions, ownership,",
  "and the gotchas that already cost someone time.",
  "",
  "One fact per line. No task progress, no user preferences, no secrets.",
  "",
  "<!-- appending below this line is safe; the agent owns this file -->",
].join("\n");

const ENTRY_RE = /^-\s+(.*?)(?:\s+\(recorded \d{4}-\d{2}-\d{2}\))?$/;

/** The fact text of one memory line, or null when it is not an entry */
export function memoryFactOf(line: string): string | null {
  const match = ENTRY_RE.exec(line.trim());
  const fact = match?.[1]?.trim();
  return fact ? fact : null;
}

/** All facts currently recorded, in file order */
export function parseMemoryFacts(text: string | null | undefined): string[] {
  if (!text) return [];
  const facts: string[] = [];
  for (const line of text.split("\n")) {
    const fact = memoryFactOf(line);
    if (fact) facts.push(fact);
  }
  return facts;
}

/** Normalized form used for duplicate detection (case/space/period-insensitive) */
function normalizeFact(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim();
}

/** True when the same fact is already recorded */
export function hasFact(text: string | null | undefined, fact: string): boolean {
  const needle = normalizeFact(fact);
  if (!needle) return true;
  return parseMemoryFacts(text).some((f) => normalizeFact(f) === needle);
}

function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Appends one fact, creating the file (header included) when absent.
 * Returns `added: false` when the fact is already recorded — recording
 * the same thing twice is noise in a file a human reviews.
 */
export function appendMemory(
  existing: string | null | undefined,
  fact: string,
  at: number = Date.now()
): { content: string; added: boolean; entry: string } {
  const clean = fact.trim().slice(0, MEMORY_FACT_MAX_CHARS).replace(/\s*\n+\s*/g, " ");
  const entry = `- ${clean} (recorded ${isoDate(at)})`;

  if (hasFact(existing, clean)) {
    return { content: existing ?? MEMORY_HEADER + "\n", added: false, entry };
  }

  const base = existing && existing.trim() ? existing.replace(/\s+$/, "") : MEMORY_HEADER;
  let next = `${base}\n${entry}\n`;

  // Keep the file bounded: drop the oldest entries past the cap.
  const lines = next.split("\n");
  const entryIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (memoryFactOf(lines[i]!)) entryIndexes.push(i);
  }
  if (entryIndexes.length > MEMORY_MAX_FACTS) {
    const drop = new Set(entryIndexes.slice(0, entryIndexes.length - MEMORY_MAX_FACTS));
    next = lines.filter((_, i) => !drop.has(i)).join("\n");
  }

  return { content: next, added: true, entry };
}

/**
 * Prompt block telling the agent this file exists. Rides in the REPO
 * prompt (stable text built from the repo context), so it costs no
 * prompt-cache stability, and it names the tool instead of relying on
 * the model to notice the path in a listing.
 */
export const MEMORY_PROMPT_BLOCK = [
  "## Project memory",
  "",
  `\`${MEMORY_PATH}\` holds durable facts about this repository recorded by earlier sessions.`,
  "Read it (read_file) before a non-trivial task — it is cheaper than rediscovering anything.",
  "Record lasting, repo-specific facts with the `remember` tool: build/verify commands,",
  "conventions, ownership, and gotchas. Do not record task progress, user preferences, or secrets.",
].join("\n");
