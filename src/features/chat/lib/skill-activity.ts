// ============================================================
// Skill Activity — What The Last Turn Actually Activated
// ============================================================
// Which skills a turn loads is decided in services/turn-prep.ts, and until
// now the only trace was a line in the turn log (session/turn-log.ts), which
// is a debugging ring buffer, not state a component can render. So the header
// could only count ENABLED skills — the always-on ones — which was already
// the least interesting half and got worse the moment matching skills started
// loading themselves.
//
// This module is the missing channel: a small, subscribable record of the
// last prepared turn's selection, keyed by conversation.
//
// Deliberately IN MEMORY and NOT part of the chat store's persisted shape.
// It describes the turn that just happened, not anything the user owns: losing
// it on reload costs one empty hover card, and storing it would mean a storage
// fingerprint, a cloud-sync field, and a migration — a real cost for a fact
// whose whole value expires at the next send.

import { useSyncExternalStore } from "react";
import { registerScopedResource } from "../identity/scoped-resources";

export interface SkillActivity {
  /** Names auto-loaded for the last prepared turn, in load order */
  auto: string[];
  /** Matched but over the cap or the char budget — the model may still pull them */
  deferred: string[];
  /** When the turn was prepared */
  at: number;
}

const byConversation = new Map<string, SkillActivity>();
const listeners = new Set<() => void>();

/** True when two records would render identically */
function sameActivity(a: SkillActivity, b: Pick<SkillActivity, "auto" | "deferred">): boolean {
  return (
    a.auto.length === b.auto.length &&
    a.deferred.length === b.deferred.length &&
    a.auto.every((n, i) => n === b.auto[i]) &&
    a.deferred.every((n, i) => n === b.deferred[i])
  );
}

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a bad consumer must not break a turn */
    }
  }
}

/**
 * Records one prepared turn's selection.
 *
 * Called on EVERY tool-capable turn, including one that matched nothing —
 * otherwise the card would keep showing the previous turn's skills and read
 * as if they were still active. The emit is skipped when the record would
 * render the same, so a long conversation is not re-rendering the header on
 * every send for no visible change.
 */
export function recordSkillActivity(
  conversationId: string,
  activity: { auto: readonly string[]; deferred: readonly string[]; at?: number }
): void {
  if (!conversationId) return;
  const next: SkillActivity = {
    auto: [...activity.auto],
    deferred: [...activity.deferred],
    at: activity.at ?? Date.now(),
  };
  const existing = byConversation.get(conversationId);
  if (existing && sameActivity(existing, next)) return;
  byConversation.set(conversationId, next);
  emit();
}

/** The last recorded activity for a conversation, or null if none yet */
export function getSkillActivity(conversationId: string | null | undefined): SkillActivity | null {
  if (!conversationId) return null;
  return byConversation.get(conversationId) ?? null;
}

/** Subscribe to any conversation's change (the hook's store contract) */
export function subscribeSkillActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget everything (tests) */
export function resetSkillActivity(): void {
  byConversation.clear();
  emit();
}

/**
 * The record is keyed by conversation, so it is a THREAD-scoped cache: when a
 * conversation is deleted, its entry describes nothing that exists. Only that
 * one entry is dropped — over-eviction is the other half of the same mistake,
 * and a repository attaching to another thread must not blank this thread's
 * card. Nothing here is derived from a repository, so no other transition
 * invalidates it.
 *
 * Registered rather than exempted because the structural test in
 * identity/registry.test.ts requires every module-level cache to declare
 * itself; a cache that is never released is how the previous repository's
 * state kept being served after a move.
 */
registerScopedResource({
  name: "skill-activity.records",
  scope: "thread",
  release: ({ transition }) => {
    if (transition.type !== "thread.deleted") return;
    if (byConversation.delete(transition.threadId)) emit();
  },
});

/**
 * Reactive read for one conversation.
 *
 * `getSnapshot` returns the stored object itself, never a fresh one: a new
 * object per call would make useSyncExternalStore re-render forever.
 */
export function useSkillActivity(conversationId: string | null | undefined): SkillActivity | null {
  return useSyncExternalStore(
    subscribeSkillActivity,
    () => getSkillActivity(conversationId),
    () => getSkillActivity(conversationId)
  );
}
