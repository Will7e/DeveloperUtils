// ============================================================
// Workspace Edit — Exact String Replacement Over Working Copy
// ============================================================
// Whole-file writes are the expensive, risky way to change code:
// they burn output tokens proportional to file size and quietly
// truncate anything the model did not have in view. This module
// implements the surgical alternative — replace one exact region —
// together with the diagnostics that make a failed match
// self-correcting instead of a guessing game.
//
// Pure and store-free so the matching rules are unit-testable.

/** Candidate lines reported when an exact match fails */
const NEAR_MISS_LINES = 3;

export interface EditOutcome {
  ok: boolean;
  /** Resulting content when ok */
  content: string;
  /** Replacements applied (0 when ok is false) */
  replacements: number;
  /** Number of occurrences found (drives the ambiguity error) */
  occurrences: number;
  /** Precise, model-facing reason when ok is false */
  error?: string;
}

/** Counts non-overlapping occurrences of `needle` in `haystack` */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Line numbers where the first meaningful line of `oldString`
 * appears — the "did you mean" hint for a failed exact match
 * (usually a whitespace or line-ending difference).
 */
export function findCandidateLines(current: string, oldString: string): number[] {
  const anchor = oldString
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!anchor) return [];
  const lines = current.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").includes(anchor)) {
      hits.push(i + 1);
      if (hits.length >= NEAR_MISS_LINES) break;
    }
  }
  return hits;
}

/**
 * Replaces `oldString` with `newString` in the CURRENT file content.
 *
 * Contract:
 *  - an empty `oldString` is refused (creating a file is write_file's job);
 *  - a missing match fails with the nearest candidate lines;
 *  - a repeated match fails unless `replaceAll` is set, so an
 *    ambiguous edit can never silently change the wrong region.
 */
export function applyStringEdit(params: {
  current: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): EditOutcome {
  const { current, oldString, newString, replaceAll = false } = params;

  if (!oldString) {
    return {
      ok: false,
      content: current,
      replacements: 0,
      occurrences: 0,
      error:
        "oldString must not be empty — use write_file to create a file, or pass the exact text you want to replace.",
    };
  }
  if (oldString === newString) {
    return {
      ok: false,
      content: current,
      replacements: 0,
      occurrences: countOccurrences(current, oldString),
      error: "oldString and newString are identical — nothing to change.",
    };
  }

  const occurrences = countOccurrences(current, oldString);

  if (occurrences === 0) {
    const candidates = findCandidateLines(current, oldString);
    const hint =
      candidates.length > 0
        ? ` Similar text appears at line${candidates.length === 1 ? "" : "s"} ${candidates.join(", ")} — read that region and copy the exact text (indentation and line endings must match).`
        : " Read the file first and copy the exact text you want to replace.";
    return {
      ok: false,
      content: current,
      replacements: 0,
      occurrences: 0,
      error: `oldString was not found in the file.${hint}`,
    };
  }

  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      content: current,
      replacements: 0,
      occurrences,
      error:
        `oldString matches ${occurrences} places. Include more surrounding context to make it unique, ` +
        "or pass replaceAll:true to change every occurrence.",
    };
  }

  // A replacer FUNCTION, not a string: `String.replace` expands `$&`,
  // ``$` ``, `$'` and `$n` in a string replacement, which silently
  // mangles any edit containing `$` — template literals, shell
  // snippets, regex source. The function form inserts text verbatim.
  const content = replaceAll
    ? current.split(oldString).join(newString)
    : current.replace(oldString, () => newString);

  return {
    ok: true,
    content,
    replacements: replaceAll ? occurrences : 1,
    occurrences,
  };
}
