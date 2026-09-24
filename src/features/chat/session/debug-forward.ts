// ============================================================
// Debug Forward — Diagnostics That Print Themselves
// ============================================================
// The turn log and the agent scorecard used to be two slash commands
// (/log, /scorecard) that printed only if someone thought to ask. Both
// answer "what went wrong", which is the one question nobody asks BEFORE
// the failure — so they were read after the fact, by someone who already
// knew the answer, in the two cases where they were remembered at all.
//
// This installs them as a console CONSUMER of the turn log: when a phase
// that means the turn lost something is recorded, the page prints the
// session's log and the scorecard itself. `window.__intabTurnLog` still
// answers the same questions on demand (session/turn-log.ts).
//
// Three rules keep it from becoming noise, because a debugger nobody
// leaves switched on is a debugger nobody has when the bug happens:
//
//   · Only failure phases forward. A turn starting is not news; a
//     failover, an abort or an error is.
//   · Dumps are coalesced. A failover storm is one incident with several
//     causes to read, not one report per log line.
//   · A consumer can never break a turn. subscribeTurnLog already guards
//     its listeners; this guards its own formatting too, because the
//     report runs inside the turn that is already failing.
// ============================================================

import { useChatStore } from "@/stores/chat.store";
import { buildScorecard, formatScorecard } from "../lib/scorecard";
import {
  formatTurnLog,
  getTurnLog,
  subscribeTurnLog,
  type TurnLogEntry,
  type TurnLogPhase,
} from "./turn-log";

/**
 * Phases that mean the turn lost something.
 *
 * `failover` belongs here because the attempt it followed FAILED — the log
 * records that failure separately, and a failover without one would itself
 * be worth seeing. `race-decided` and `stream-end` do not: they describe a
 * turn that worked.
 */
export const FORWARDED_PHASES: ReadonlySet<TurnLogPhase> = new Set<TurnLogPhase>([
  "error",
  "model-failure",
  "failover",
  "abort",
  "orphan-abort",
]);

/** True when a log phase is worth a printed dump. Pure, so it is testable. */
export function shouldAutoForward(phase: TurnLogPhase): boolean {
  return FORWARDED_PHASES.has(phase);
}

/** One dump per this window, so a burst of failures reads as one incident. */
export const COALESCE_MS = 3000;

let lastForwardedAt = 0;

/** Clears the coalescing clock (tests, and a page that wants a clean slate). */
export function resetDebugForward(): void {
  lastForwardedAt = 0;
}

/**
 * Prints the turn log and the scorecard for the current page state.
 *
 * The scorecard is recomputed from the transcript on every dump rather than
 * cached, because the failure being reported is the newest thing that
 * happened and a stale rate is worse than no rate.
 */
export function forwardDiagnostics(entry: TurnLogEntry): void {
  console.groupCollapsed(
    `[intab] turn diagnostics — ${entry.phase}` +
      (entry.detail ? `: ${entry.detail}` : "") +
      (entry.modelId ? ` (${entry.modelId})` : "")
  );
  console.log(formatTurnLog() || "(turn log is empty)");
  console.log(
    "\n" +
      formatScorecard(
        buildScorecard(useChatStore.getState().conversations, getTurnLog())
      )
  );
  console.groupEnd();
}

/**
 * Subscribes the page's diagnostics to the turn log and returns the
 * unsubscribe, so the caller owns the lifetime (a React effect can return it
 * directly, which also makes StrictMode's double-invoke harmless).
 */
export function installDebugForward(): () => void {
  return subscribeTurnLog((entry) => {
    if (!shouldAutoForward(entry.phase)) return;
    const now = Date.now();
    if (now - lastForwardedAt < COALESCE_MS) return;
    lastForwardedAt = now;
    try {
      forwardDiagnostics(entry);
    } catch {
      /* a debugger must never break the turn it is describing */
    }
  });
}
