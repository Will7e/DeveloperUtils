// ============================================================
// Verification Ledger — what was actually proven, and about which code
// ============================================================
// Two things in this product produce real evidence instead of prose: the
// in-browser type check (over the workspace's own sources) and behaviour
// probes (executed in the running preview). Both used to evaporate the
// moment the tool call returned — the model would mention them, the
// reviewer could not check, and the PR carried only the agent's word.
//
// This ledger keeps the last result of each kind per conversation, tagged
// with the workspace revision it describes. Staleness is DERIVED by
// comparison, never maintained: nothing has to remember to invalidate an
// entry when a file is edited, because an entry is only ever "fresh" when
// the revision it names is still the current one. That asymmetry is the
// whole design — real evidence goes stale silently and instantly, which is
// exactly what a claim written after a later edit should be.

import type { PushWarning } from "../types";

export type VerificationKind = "typecheck" | "probes";

export interface VerificationEvent {
  kind: VerificationKind;
  /** Epoch ms of the run */
  at: number;
  /** workspace.updatedAt at the time of the run — the revision proven */
  workspaceUpdatedAt: number;
  ok: boolean;
  /** One honest line, e.g. "typecheck: 0 errors across 41 files" */
  summary: string;
  /** Failure lines or diagnostics, already capped by the producer */
  details?: string[];
  /** Where it ran (tool name, probe runner) — attributed, never implied */
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
  forConversation.set(event.kind, { ...event, details: event.details?.slice(0, 20) });
}

/**
 * Evidence visible to a reviewer, newest run per kind, with staleness
 * resolved against the revision the caller is actually looking at.
 */
export function verificationEvidence(
  conversationId: string,
  current: { workspaceUpdatedAt: number; now?: number }
): VerificationEvidence[] {
  const forConversation = ledger.get(conversationId);
  if (!forConversation) return [];
  const now = current.now ?? Date.now();
  const order: VerificationKind[] = ["typecheck", "probes"];
  const out: VerificationEvidence[] = [];
  for (const kind of order) {
    const event = forConversation.get(kind);
    if (!event) continue;
    const fresh = event.workspaceUpdatedAt === current.workspaceUpdatedAt;
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
}

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
  probes: "Behaviour probes (executed in the running preview)",
};

/**
 * Reviewer-facing lines. Deliberately includes the stale case explicitly:
 * "probes passed" about code that has since changed is the exact sentence
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
        kind: e.kind === "probes" ? "probes" : "checks",
        message: `${VERIFICATION_KIND_LABEL[e.kind]} ran against this exact workspace revision and FAILED: ${e.summary}. ${
          (e.details ?? []).length > 0 ? `First failures — ${(e.details ?? []).slice(0, 3).join(" | ")}. ` : ""
        }Do not merge this as a fix.`,
      });
      continue;
    }
    if (e.status === "stale" && e.ok) {
      out.push({
        kind: e.kind === "probes" ? "probes" : "checks",
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
  const unrun = ["Test suite, linter and build commands", "User-visible behaviour outside the probed flows"];
  return [
    "### In-browser verification",
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    `_Not run in this workspace: ${unrun.join("; ")}._`,
  ].join("\n");
}
