// ============================================================
// Auto-Verify — The Type Check That Runs Without Being Asked
// ============================================================
// The verification ledger records what RAN, and the completion gate reads
// it — but every entry used to depend on the model choosing to verify.
// Forgetting is the failure this module removes: after the agent writes
// files, the workspace's own type check runs here, on a debounce, and its
// result lands in the ledger like any other evidence.
//
// Three properties make this safe rather than eager:
//
//   • ONE check per burst. A multi-file edit lands as a stream of writes;
//     the debounce (AUTO_VERIFY_DEBOUNCE_MS) folds them into a single run
//     against the final revision, and single-flight means a run in flight
//     is never overlapped by another.
//   • The revision decides freshness, as always. The result is recorded
//     against the workspace revision that existed WHEN THE CHECK STARTED;
//     the next edit makes it stale by comparison, with nothing to
//     invalidate by hand (verification-ledger.ts's whole design).
//   • Absence stays silent. No workspace, no compilable sources, no
//     container — none of it records evidence or nags anyone. An
//     unavailable check must not look like a passed one, so it records
//     nothing at all.
//
// The run is real work: it uses the same worker and the same planning code
// as run_checks, so its evidence is the same evidence a manual check would
// have produced — recorded, with `source: "auto-verify"`, so a reviewer can
// tell the two apart.
// ============================================================

import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import {
  AUTO_VERIFY_DEBOUNCE_MS,
  AUTO_VERIFY_MAX_QUEUED_PER_CONVERSATION,
} from "../constants";
import { recordVerification } from "../lib/verification-ledger";
import type { WorkspaceState } from "../types";

/** The one supported kind, until the lint tier exists */
type AutoVerifyKind = "typecheck";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<void>>();

/** Test seam: cancel everything without running a check */
export function resetAutoVerify(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  inFlight.clear();
}

/** Cancels one conversation's pending check (thread deleted, turn stopped) */
export function cancelAutoVerify(conversationId: string): void {
  const timer = timers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(conversationId);
  }
}

/**
 * Requests a type check for this conversation after the debounce.
 *
 * Called by the write path (workspace publishes), never by the model: the
 * whole point is that the agent does not have to remember. Repeated calls
 * inside the window collapse into one timer — the LAST workspace state wins,
 * because the check reads the store at run time rather than a snapshot.
 */
export function requestAutoVerify(conversationId: string): void {
  const existing = timers.get(conversationId);
  if (existing) clearTimeout(existing);
  // A queued burst replaces any pending one, and the queue itself is bounded
  // globally (the map is keyed per conversation but the ceiling counts all
  // of them): a pathological writer cannot grow the map without end.
  if (timers.size > AUTO_VERIFY_MAX_QUEUED_PER_CONVERSATION) {
    const oldest = timers.keys().next().value;
    if (oldest !== undefined && oldest !== conversationId) {
      clearTimeout(timers.get(oldest)!);
      timers.delete(oldest);
    }
  }
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      void runAutoVerify(conversationId);
    }, AUTO_VERIFY_DEBOUNCE_MS)
  );
}

/**
 * Runs the check now (bypassing the debounce) and records the result.
 *
 * Exported for tests and for the store's own flush points; the debounced
 * path is `requestAutoVerify`.
 */
export async function runAutoVerify(conversationId: string): Promise<void> {
  const previous = inFlight.get(conversationId);
  if (previous) return previous;

  const run = (async () => {
    const ws = selectWorkspace(useChatStore.getState(), conversationId);
    if (!ws) return;

    // No sources, nothing to check — and nothing to record. A workspace of
    // markdown has no honest verdict, and recording "unavailable" would put
    // a non-evidence into a ledger a reviewer reads as evidence.
    const sources = Object.entries(ws.files).filter(
      ([path, file]) =>
        file.status !== "deleted" && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)
    );
    if (sources.length === 0) return;

    // The revision the check is ABOUT. Captured before the await: any write
    // that lands while the compiler runs makes this value stale by
    // comparison, which is exactly the semantics the ledger derives.
    const workspaceUpdatedAt = ws.updatedAt;
    const startedAt = Date.now();

    const { runTypecheck } = await import("../lib/typecheck-client");
    const result = await runTypecheck({
      files: sources.map(([path, file]) => ({ path, content: file.content })),
      tsconfigRaw:
        ws.files["tsconfig.json"]?.content ?? ws.files["jsconfig.json"]?.content ?? null,
      treePaths: ws.tree.map((entry) => entry.path),
      changedPaths: Object.entries(ws.files)
        .filter(([, file]) => file.status !== "unchanged")
        .map(([path]) => path),
    });

    if (result.unavailableReason) {
      // Unavailable is not a pass and not a fail — it records nothing, so no
      // reviewer ever reads "0 errors" about a check that never ran.
      return;
    }

    const errors = result.classification.reported.filter((d) => d.category === 1);
    recordVerification(conversationId, {
      kind: "typecheck" as AutoVerifyKind,
      at: startedAt,
      workspaceUpdatedAt,
      ok: errors.length === 0,
      summary:
        errors.length === 0
          ? `auto typecheck: 0 errors across ${result.checkedFiles} file(s)`
          : `auto typecheck: ${errors.length} error(s) across ${result.checkedFiles} file(s)`,
      details:
        errors.length > 0
          ? errors.slice(0, 8).map((d) => {
              const location = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "tsconfig";
              return `${location} — TS${d.code} ${d.message.replace(/\s+/g, " ").trim()}`;
            })
          : undefined,
      source: "auto-verify",
    });
  })().catch(() => {
    // A failed auto-check is silent by design: it records no evidence, and
    // the manual run_checks path remains the way to surface a real error.
  }).finally(() => {
    inFlight.delete(conversationId);
  });

  inFlight.set(conversationId, run);
  return run;
}
