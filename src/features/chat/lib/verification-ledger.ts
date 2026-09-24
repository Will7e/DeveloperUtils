// ============================================================
// Verification Ledger — what was actually proven, and about which code
// ============================================================
// Real evidence instead of prose: the in-browser type check (over the
// workspace's own sources), a real command in a working tree on the user's
// machine, and the repository's own workflow on the pushed branch. All of it
// used to evaporate the moment the tool call returned — the model would
// mention it, the reviewer could not check, and the PR carried only the
// agent's word.
//
// This ledger keeps the last result of each kind per conversation, tagged
// with the workspace revision it describes. Staleness is DERIVED by
// comparison, never maintained: nothing has to remember to invalidate an
// entry when a file is edited, because an entry is only ever "fresh" when
// the revision it names is still the current one. That asymmetry is the
// whole design — real evidence goes stale silently and instantly, which is
// exactly what a claim written after a later edit should be.

import type { PushWarning } from "../types";
import { bindingIdOf } from "../identity/bindings";
import { registerScopedResource } from "../identity/scoped-resources";

/**
 * The kinds of evidence this product can actually produce.
 *
 * `typecheck` runs inside the browser over the workspace's own sources.
 * `command` and `ci` are stronger: a real command in a real working tree on
 * the user's machine (`run_command`), and the repository's own workflow on
 * the pushed branch (`verify_with_ci`). They belong in the same ledger
 * because the question a reviewer asks is the same one — what was proven,
 * about which revision — and because the strongest evidence available should
 * not be the only evidence nothing records.
 */
export type VerificationKind = "typecheck" | "command" | "ci";

/** Display order: cheapest/most local first, most authoritative last. */
export const VERIFICATION_ORDER: readonly VerificationKind[] = [
  "typecheck",
  "command",
  "ci",
];

export interface VerificationEvent {
  kind: VerificationKind;
  /** Epoch ms of the run */
  at: number;
  /** workspace.updatedAt at the time of the run — the revision proven */
  workspaceUpdatedAt: number;
  /**
   * The thread-on-repository this evidence is about.
   *
   * Stamped by `recordVerification` from the thread's binding, and never by the
   * caller. Conversation and revision were not enough on their own: a thread
   * that moved from one repository to another could present a run made against
   * the first as current for the second whenever the two happened to share a
   * revision number — a false "verified" on a push gate, which is a stronger
   * failure than a stale pane. The revision still decides freshness; this decides
   * WHAT the revision was a revision of.
   */
  bindingId?: string;
  ok: boolean;
  /** One honest line, e.g. "typecheck: 0 errors across 41 files" */
  summary: string;
  /** Failure lines or diagnostics, already capped by the producer */
  details?: string[];
  /** Where it ran (tool name) — attributed, never implied */
  source?: string;
}

export type VerificationStatus = "fresh-pass" | "fresh-fail" | "stale";

export interface VerificationEvidence extends VerificationEvent {
  status: VerificationStatus;
  ageMs: number;
}

/** Last event per kind. A newer run replaces the older one for that kind. */
const ledger = new Map<string, Map<VerificationKind, VerificationEvent>>();

/** Conversation ceiling: the ledger is a cache of what a human may be shown. */
const MAX_CONVERSATIONS = 40;

// ── Subscriptions ────────────────────────────────────────────
// The ledger is read by the UI now, not only by the push gate, and it is a
// module-level map with nothing to re-render on. Polling would have been the
// alternative and it is the wrong one: evidence lands in bursts (at the end of
// a run) and a stale badge for four seconds is exactly the window in which a
// user reads "Verified" about code they just changed.
//
// The version counter is what `useSyncExternalStore` compares, because the
// evidence array is rebuilt per read and an array identity would never be
// stable.

const listeners = new Set<() => void>();
let version = 0;

/** Subscribe to ledger mutations. Returns the unsubscribe function. */
export function subscribeVerification(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic revision of the ledger itself, for snapshot comparison. */
export function verificationVersion(): number {
  return version;
}

function notifyVerification(): void {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A failing subscriber must not break evidence recording for the rest.
    }
  }
}

export function recordVerification(
  conversationId: string,
  event: VerificationEvent
): void {
  if (!conversationId) return;
  let forConversation = ledger.get(conversationId);
  if (!forConversation) {
    forConversation = new Map();
    ledger.set(conversationId, forConversation);
    // Oldest conversations fall out first; there is no ordering to keep
    // beyond insertion, so the first key is the right victim.
    if (ledger.size > MAX_CONVERSATIONS) {
      const oldest = ledger.keys().next().value;
      if (oldest !== undefined && oldest !== conversationId) ledger.delete(oldest);
    }
  }
  forConversation.set(event.kind, {
    ...event,
    // Derived, not asked for: a caller that forgets to pass it would otherwise
    // record evidence against nothing in particular, and "nothing in
    // particular" is exactly what a reviewer reads as "this diff".
    bindingId: event.bindingId ?? bindingIdOf(conversationId),
    details: event.details?.slice(0, 20),
  });
  notifyVerification();
}

/**
 * Evidence visible to a reviewer, newest run per kind, with staleness
 * resolved against the revision the caller is actually looking at.
 */
export function verificationEvidence(
  conversationId: string,
  current: { workspaceUpdatedAt: number; bindingId?: string; now?: number }
): VerificationEvidence[] {
  const forConversation = ledger.get(conversationId);
  if (!forConversation) return [];
  const now = current.now ?? Date.now();
  const binding = current.bindingId ?? bindingIdOf(conversationId);
  const out: VerificationEvidence[] = [];
  for (const kind of VERIFICATION_ORDER) {
    const event = forConversation.get(kind);
    if (!event) continue;
    // Same REVISION and same BINDING. An entry recorded before this thread
    // switched repository names a different repository, so it is stale no
    // matter how its revision number compares.
    const fresh =
      event.workspaceUpdatedAt === current.workspaceUpdatedAt &&
      (event.bindingId === undefined || event.bindingId === binding);
    out.push({
      ...event,
      status: !fresh ? "stale" : event.ok ? "fresh-pass" : "fresh-fail",
      ageMs: Math.max(0, now - event.at),
    });
  }
  return out;
}

/** A single event, for callers that only care about one kind. */
export function verificationEvent(
  conversationId: string,
  kind: VerificationKind
): VerificationEvent | null {
  return ledger.get(conversationId)?.get(kind) ?? null;
}

export function clearVerification(conversationId?: string): void {
  if (conversationId) ledger.delete(conversationId);
  else ledger.clear();
  notifyVerification();
}

/** Drops every entry recorded for one binding, across every thread */
export function clearVerificationForBinding(bindingId: string): void {
  let changed = false;
  for (const [conversationId, byKind] of ledger) {
    for (const [kind, event] of byKind) {
      if (event.bindingId === bindingId) {
        byKind.delete(kind);
        changed = true;
      }
    }
    if (byKind.size === 0) ledger.delete(conversationId);
  }
  if (changed) notifyVerification();
}

/**
 * Evidence is released when the code it describes stops being the code in play.
 *
 *   • `base.moved` — a push moved the branch, so every entry for that binding
 *     describes a parent commit. The ledger's own staleness rule would catch
 *     this on the next read, but only against a workspace revision that can be
 *     compared; dropping is unconditional, and a claim that cannot be re-read is
 *     not a claim anybody can make.
 *   • `thread.deleted` — the thread is gone, so its ledger entries are memory
 *     held for a conversation that does not exist.
 *
 * Switching repository releases nothing, and needs to: the entries are stamped
 * with the binding, so a switch makes them stale by comparison rather than by
 * anyone remembering to clear them.
 */
registerScopedResource({
  name: "verification-ledger.events",
  scope: "binding",
  release: ({ transition }) => {
    if (transition.type === "base.moved" && transition.next) {
      clearVerificationForBinding(transition.next);
      return;
    }
    if (transition.type === "thread.deleted") clearVerification(transition.threadId);
  },
});

/** "4 minutes ago" — evidence with an age reads as evidence, not as fact. */
export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)}h ago`;
}

export const VERIFICATION_KIND_LABEL: Record<VerificationKind, string> = {
  typecheck: "Type check (in-browser, over the workspace sources)",
  command: "Command (run in a working tree on your machine)",
  ci: "GitHub Actions (the repository's own workflow)",
};

/**
 * Reviewer-facing lines. Deliberately includes the stale case explicitly:
 * "checks passed" about code that has since changed is the exact sentence
 * this feature exists to prevent, and staying silent about it would
 * recreate the problem in a new place.
 */
export function verificationLines(evidence: VerificationEvidence[]): string[] {
  return evidence.map((e) => {
    if (e.status === "stale") {
      return `${VERIFICATION_KIND_LABEL[e.kind]}: ran ${formatAge(e.ageMs)} and ${e.ok ? "passed" : "failed"}, but the workspace changed afterwards — it does not describe the current code.`;
    }
    const verdict = e.status === "fresh-pass" ? "passed" : "FAILED";
    return `${VERIFICATION_KIND_LABEL[e.kind]}: ${verdict} — ${e.summary} (${formatAge(e.ageMs)}).`;
  });
}

/** Approval-gate warnings: only for results that contradict the diff. */
export function verificationWarnings(evidence: VerificationEvidence[]): PushWarning[] {
  const out: PushWarning[] = [];
  for (const e of evidence) {
    if (e.status === "fresh-fail") {
      out.push({
        kind: "checks",
        message: `${VERIFICATION_KIND_LABEL[e.kind]} ran against this exact workspace revision and FAILED: ${e.summary}. ${
          (e.details ?? []).length > 0 ? `First failures — ${(e.details ?? []).slice(0, 3).join(" | ")}. ` : ""
        }Do not merge this as a fix.`,
      });
      continue;
    }
    if (e.status === "stale" && e.ok) {
      out.push({
        kind: "checks",
        message: `${VERIFICATION_KIND_LABEL[e.kind]} passed ${formatAge(e.ageMs)}, but the workspace has changed since — that result describes older code, not this diff. Re-run it to make the claim good.`,
      });
    }
  }
  return out;
}

/**
 * The PR-body section. A pull request that carries its own evidence is
 * reviewable at a glance: the reviewer sees what ran, what did not, and
 * how old the result is, without trusting a paragraph.
 */
export function proofSection(evidence: VerificationEvidence[]): string | null {
  if (evidence.length === 0) return null;
  const lines = verificationLines(evidence);
  // The "not run" line is DERIVED, not written down. It used to name the
  // test suite and the linter unconditionally, because nothing in this
  // product could run them — and a PR body that says "tests were not run"
  // underneath a passing `npm test` is worse than no proof section at all.
  const ran = new Set(evidence.map((e) => e.kind));
  const unrun: string[] = [];
  if (!ran.has("command")) unrun.push("Test suite, linter and build commands");
  if (!ran.has("ci")) unrun.push("The repository's CI on this branch");
  if (!ran.has("typecheck")) unrun.push("The workspace type check");
  const heading = ran.has("command") || ran.has("ci") ? "### Verification" : "### In-browser verification";
  return [
    heading,
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    ...(unrun.length > 0 ? [`_Not run in this workspace: ${unrun.join("; ")}._`] : []),
  ].join("\n");
}
