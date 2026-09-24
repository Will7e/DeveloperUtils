// ============================================================
// App Action Ledger — Every Change The Agent Made To The App
// ============================================================
// The agent is allowed to act on the app by default. That is only defensible
// if the app can say what it did and put it back, so each write through
// `act_app` records two things: a row the user (and the agent) can read, and
// the closure that reverses it.
//
// The reversal is stored as a FUNCTION, not as a description, because a
// description of an undo is a second implementation that can disagree with the
// first. It is captured at write time from the state that was there before the
// call, so undoing a rename puts back the exact previous name rather than
// asking the store to rename it again.
//
// Bounded on purpose (LEDGER_LIMIT): an afternoon of agent work must not grow
// without limit, and the oldest entries are the least likely to be undone. The
// bound is generous because an entry is small — a summary line and a closure —
// and dropping the wrong one is worse than holding it.
//
// Scope: "thread". This is a record of what happened in one conversation, and
// a cache-like structure in this codebase declares its scope (see
// identity/scoped-resources.ts, and the structural test that enforces it).

import { registerScopedResource } from "../identity/scoped-resources";

export interface AppActionRecord {
  id: string;
  /**
   * Monotonic sequence number.
   *
   * `at` is a wall clock and a fast agent can record several actions in the
   * same millisecond, which makes "newest first" ambiguous exactly when it
   * matters ("undo the thing I just did"). Ordering by this instead is exact,
   * and it is what the activity list is sorted by.
   */
  seq: number;
  family: string;
  action: string;
  /** One line, in the words the activity row uses */
  summary: string;
  at: number;
  /** True once the reversal has been applied */
  undone: boolean;
}

interface LedgerEntry {
  record: AppActionRecord;
  undo: () => void;
}

/** How many actions are kept; the oldest are dropped first */
const LEDGER_LIMIT = 200;

const entries = new Map<string, LedgerEntry>();

registerScopedResource({
  name: "app-action-ledger.entries",
  scope: "thread",
  release: () => {
    entries.clear();
  },
});

/** Monotonic id: readable in a transcript, unique within a session */
let counter = 0;

/**
 * Records a change and its reversal.
 *
 * `undo` is called at most once — `undoAppAction` marks the record and refuses
 * a second attempt, because replaying a closure against state it was not
 * captured from is how an undo corrupts what it means to restore.
 */
export function recordAppAction(params: {
  family: string;
  action: string;
  summary: string;
  undo: () => void;
}): AppActionRecord {
  counter += 1;
  const record: AppActionRecord = {
    id: `app-act-${counter}`,
    seq: counter,
    family: params.family,
    action: params.action,
    summary: params.summary,
    at: Date.now(),
    undone: false,
  };
  entries.set(record.id, { record, undo: params.undo });
  if (entries.size > LEDGER_LIMIT) {
    const oldest = [...entries.values()].sort((a, b) => a.record.seq - b.record.seq)[0];
    if (oldest) entries.delete(oldest.record.id);
  }
  return record;
}

/** What the agent has changed, newest first */
export function listAppActions(limit = 50): AppActionRecord[] {
  return [...entries.values()]
    .map((e) => e.record)
    .sort((a, b) => b.seq - a.seq)
    .slice(0, Math.max(0, limit));
}

export type UndoOutcome =
  | { ok: true; record: AppActionRecord }
  | { ok: false; error: string };

/**
 * Applies one recorded reversal.
 *
 * A failure here is reported, never thrown: the undo runs after a store call
 * the user already saw, so the honest outcome is "the change stands and here
 * is why I could not put it back".
 */
export function undoAppAction(id: string): UndoOutcome {
  const entry = entries.get(id);
  if (!entry) {
    const known = listAppActions(5)
      .map((r) => r.id)
      .join(", ");
    return {
      ok: false,
      error: `No recorded action with id "${id}"${known ? `. Recent ids: ${known}` : ""} — read the \`activity\` family for the current list.`,
    };
  }
  if (entry.record.undone) {
    return { ok: false, error: `Action "${id}" was already undone, so there is nothing left to restore.` };
  }
  try {
    entry.undo();
  } catch (err) {
    return {
      ok: false,
      error: `Could not undo "${id}": ${err instanceof Error ? err.message : String(err)}. The change stands — tell the user rather than retrying.`,
    };
  }
  entry.record.undone = true;
  return { ok: true, record: entry.record };
}

/** Test seam: forget the ledger */
export function resetAppActionLedger(): void {
  entries.clear();
  counter = 0;
}
