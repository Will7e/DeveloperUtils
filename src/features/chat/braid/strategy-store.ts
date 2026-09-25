// ============================================================
// Strategy Store — Braid's long-term memory of what worked
// ============================================================
// Distilled strategy entries per repository, persisted in IndexedDB
// through the app's shared KV store (`idb-storage.service`). This is
// the ReasoningBank half of Braid: not raw transcripts — every turn
// here already lives in the conversation history — but the transferable
// half of a finished turn: what triggered the problem, what fixed it,
// and what to avoid next time.
//
// Scope: one key per REPOSITORY ATTACHMENT (owner/repo/branch), not per
// conversation. A strategy is code knowledge — it belongs to the repo,
// so every thread on the same checkout benefits, and nothing can leak
// across repositories (see `scopeToBinding` — an entry never reads or
// writes a different binding's key).
//
// Storage note: the idb KV service falls back to localStorage when IDB
// is unavailable, and entries are small (a few hundred chars), so this
// module needs no quota strategy beyond its own caps.

import { readValue, writeValue } from "@/services/idb-storage.service";

/** One distilled, reusable strategy */
export interface StrategyEntry {
  /** Monotonic within this binding (Date.now-based with a counter tiebreak) */
  id: string;
  /** The situation that calls for it, e.g. "the push gate reports stale evidence" */
  trigger: string;
  /** What actually works, e.g. "revert past the failing edit, then re-apply" */
  strategy: string;
  /** What to avoid, when there is one */
  pitfall?: string;
  /** Weight grows when a strategy is retrieved and used again */
  confidence: number;
  /** Epoch ms — recency feeds the ranking and eviction */
  recordedAt: number;
  /** The conversation this was distilled from, for provenance */
  sourceConversationId: string;
  /**
   * How the turn ended: strategies from verified turns rank above ones
   * from turns that merely stopped. Never a claim — the transcript that
   * produced it is inspectable in its conversation.
   */
  outcome: "verified" | "stopped" | "failed";
  /** How many times this entry has been injected into a prompt */
  useCount: number;
  /** Last time it was injected */
  lastUsedAt?: number;
}

/** Cap per binding — eviction drops the lowest-ranked entries past this */
export const STRATEGIES_MAX_PER_BINDING = 200;

/** All stored entries for one repository binding, empty when none */
export async function loadStrategies(repo: {
  owner: string;
  repo: string;
  branch: string;
}): Promise<StrategyEntry[]> {
  const raw = await readValue(strategiesKey(repo));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStrategyEntry);
  } catch {
    return [];
  }
}

/**
 * Adds one entry (dedup by trigger+strategy), then applies the cap.
 * Returns the deduped-merge outcome so the caller can report it honestly.
 */
export async function addStrategy(
  repo: { owner: string; repo: string; branch: string },
  entry: Omit<StrategyEntry, "id" | "confidence" | "useCount">
): Promise<{ ok: boolean; deduped: boolean }> {
  const existing = await loadStrategies(repo);
  const match = findDuplicate(existing, entry);
  if (match) {
    // Relearned: same lesson, another turn. Bump confidence and outcome
    // rather than stacking a near-identical entry.
    const upgraded: StrategyEntry = {
      ...match,
      confidence: Math.min(5, round2(match.confidence + 0.5)),
      outcome: strongerOutcome(match.outcome, entry.outcome),
      ...(entry.pitfall && !match.pitfall ? { pitfall: entry.pitfall } : {}),
    };
    const next = existing.map((s) => (s.id === match.id ? upgraded : s));
    await writeValue(strategiesKey(repo), JSON.stringify(next));
    return { ok: true, deduped: true };
  }

  const created: StrategyEntry = {
    ...entry,
    id: `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    confidence: 1,
    useCount: 0,
  };
  const next = [...existing, created];
  const capped = next.length > STRATEGIES_MAX_PER_BINDING ? evictLowest(next) : next;
  await writeValue(strategiesKey(repo), JSON.stringify(capped));
  return { ok: true, deduped: false };
}

/** Stores an explicit, human-curated batch (e.g. seeding) — replaces duplicates */
export async function addStrategies(
  repo: { owner: string; repo: string; branch: string },
  entries: Array<Omit<StrategyEntry, "id" | "confidence" | "useCount">>
): Promise<number> {
  let added = 0;
  for (const entry of entries) {
    const result = await addStrategy(repo, entry);
    if (!result.deduped) added += 1;
  }
  return added;
}

/** Removes one entry by id */
export async function removeStrategy(
  repo: { owner: string; repo: string; branch: string },
  id: string
): Promise<boolean> {
  const existing = await loadStrategies(repo);
  const next = existing.filter((s) => s.id !== id);
  if (next.length === existing.length) return false;
  await writeValue(strategiesKey(repo), JSON.stringify(next));
  return true;
}

/** Records that an entry was injected into a prompt (useCount/recency) */
export async function markStrategiesUsed(
  repo: { owner: string; repo: string; branch: string },
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const existing = await loadStrategies(repo);
  const used = new Set(ids);
  const now = Date.now();
  const next = existing.map((s) =>
    used.has(s.id) ? { ...s, useCount: s.useCount + 1, lastUsedAt: now } : s
  );
  await writeValue(strategiesKey(repo), JSON.stringify(next));
}

/** Deletes every entry for this binding */
export async function clearStrategies(repo: {
  owner: string;
  repo: string;
  branch: string;
}): Promise<void> {
  await writeValue(strategiesKey(repo), null);
}

// ── Internals ─────────────────────────────────────────────────

function strategiesKey(repo: { owner: string; repo: string; branch: string }): string {
  return `braid:strategies:${repo.owner}/${repo.repo}/${repo.branch}`;
}

/** Normalized trigger+strategy equality — whitespace/case/period insensitive */
function findDuplicate(
  existing: StrategyEntry[],
  entry: Omit<StrategyEntry, "id" | "confidence" | "useCount">
): StrategyEntry | null {
  const needle = normalize(`${entry.trigger}::${entry.strategy}`);
  return existing.find((s) => normalize(`${s.trigger}::${s.strategy}`) === needle) ?? null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.]+$/, "").trim();
}

function strongerOutcome(
  a: StrategyEntry["outcome"],
  b: StrategyEntry["outcome"]
): StrategyEntry["outcome"] {
  const rank = { verified: 2, stopped: 1, failed: 0 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Eviction: drop the lowest-ranked entry until the list fits.
 * Rank = outcome × 2 + confidence + recency-decayed use. Never drops
 * an entry that is younger than a minute — a just-learned strategy must
 * not be evicted by the very write that created it.
 */
function evictLowest(entries: StrategyEntry[]): StrategyEntry[] {
  const next = [...entries];
  while (next.length > STRATEGIES_MAX_PER_BINDING) {
    const now = Date.now();
    let worstIdx = -1;
    let worstScore = Number.POSITIVE_INFINITY;
    next.forEach((s, i) => {
      const ageDays = (now - s.recordedAt) / 86_400_000;
      const score =
        outcomeRank(s.outcome) * 2 + s.confidence + Math.max(0, s.useCount) - ageDays * 0.01;
      if (now - s.recordedAt < 60_000) return; // grace for fresh entries
      if (score < worstScore) {
        worstScore = score;
        worstIdx = i;
      }
    });
    // All entries fresh (impossible at 200+ entries in practice): drop the oldest.
    if (worstIdx === -1) {
      const oldest = next.reduce(
        (min, s, i) => (s.recordedAt < next[min]!.recordedAt ? i : min),
        0
      );
      next.splice(oldest, 1);
    } else {
      next.splice(worstIdx, 1);
    }
  }
  return next;
}

function outcomeRank(outcome: StrategyEntry["outcome"]): number {
  return outcome === "verified" ? 2 : outcome === "stopped" ? 1 : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Structural guard: storage corruption or schema drift yields [] rather than a crash */
function isStrategyEntry(value: unknown): value is StrategyEntry {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.trigger === "string" &&
    typeof s.strategy === "string" &&
    typeof s.confidence === "number" &&
    typeof s.recordedAt === "number" &&
    typeof s.sourceConversationId === "string" &&
    (s.outcome === "verified" || s.outcome === "stopped" || s.outcome === "failed") &&
    typeof s.useCount === "number" &&
    (s.pitfall === undefined || typeof s.pitfall === "string") &&
    (s.lastUsedAt === undefined || typeof s.lastUsedAt === "number")
  );
}
