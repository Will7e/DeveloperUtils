# InTab Threads — Concurrent Agent Workstreams on One Repository

> **One sentence:** Isolation makes several agent threads on one repository *safe* (each writes its own branch, and every branch write is a compare-and-swap that fails loudly instead of racing), while a shared, encrypted, revision-ordered thread registry makes them *aware* of each other — so a second thread knows which paths are already being rewritten, what the other is trying to do, and whether its branch is integrating into a trunk that has moved.

This is the sibling of [Forge](./intab-forge.md). Forge makes **K candidates** for one task first-class; Threads make **K workstreams over time** first-class. Both are only rational in a browser-native agent: the coordination state has to live somewhere cheap and local, and the verification that gates integration has to be something you can actually run in the tab.

---

## 1. Why competitors can't copy it cheaply

| Competitor | Their concurrency model | Structural weakness |
|---|---|---|
| CLI agents on a shared checkout | N agents, one working tree | Branch collisions, shared index, stash chaos, unattributable dirty state |
| Worktree runners (Claude Code / Codex style) | One worktree + branch per agent | Safe, but the agents are *blind* to each other; coordination is the human reading five terminals |
| Cloud task runners (Jules / Copilot coding agent class) | One VM + branch + PR per task | Coordination is the PR queue, and every coordination step costs a remote round trip and a sandbox boot |
| InTab today | One conversation → one working branch → one PR | Isolation is already correct ✅, awareness is zero: threads cannot see each other at all |

The gap we can close that others structurally can't: **coordination that costs nothing.** No VM, no server, no round trip. The registry lives in the same browser the agents already run in, and cross-tab consistency comes from primitives every modern browser ships.

---

## 2. The two problems people conflate

**Safety** (two writers, one artifact) and **awareness** (each agent knowing the others). Safety is solved by *isolation plus serialization*; awareness is a separate, cheaper layer. Getting this backwards is the classic failure: a perfect shared log still corrupts a repository that two agents write to; a perfect lock still wastes a whole turn of work when nobody published intent.

Consequences that shape every rule below:

1. **Claims are advisory.** A path claim prevents wasted work and confusing diffs. It is never the only thing standing between two threads and corruption — branch-per-thread isolation is. Therefore no coordination failure may ever block a write: every API fails open.
2. **Ordering is by revision, never by wall clock.** Wall-clock comparison already cost us silent edit loss once (the cloud-sync conflict comparison). Nothing here compares timestamps except to decide expiry.

---

## 3. The model

### 3.1 Isolation (exists ✅)

Already shipped, and unchanged by this spec:

| Piece | Where |
|---|---|
| `create_working_branch` creates the thread's branch | `services/agent-actions.ts` |
| `ws.workingBranch` remembers it on the workspace | `chat/types.ts`, `workspace/workspace.ts` |
| `isProtectedBranchName` refuses the trunk | `lib/github-write.ts` |
| `updateRef(..., { force: false })` — a non-fast-forward returns 409/422, i.e. **compare-and-swap for free** | `lib/github-write.ts` |
| Blob → tree → commit → ref → PR chain | `lib/github-write.ts` |
| Reviewer-facing preflight (base moved, upstream changed, read-only token, unverifiable checks) | `services/agent-actions.ts` |

### 3.2 Awareness (new — this spec)

A registry of live threads, one record per conversation:

```ts
interface AgentThread {
  threadId: string;      // stable, one per conversation
  label: string;         // conversation title, clamped
  tabId: string;         // presence lives per tab
  deviceId: string;      // same key cloud-sync uses
  owner: string; repo: string;
  branch: string;        // where it writes
  base: string;          // what it integrates into
  intent: string;        // one line: what it is trying to do
  planStep?: string;
  status: "planning" | "editing" | "verifying" | "waiting-approval" | "idle";
  epoch: number;         // monotonic per thread
  heartbeatAt: number;
  claims: PathClaim[];   // expiring, path-scoped leases
}

interface PathClaim { path: string; threadId: string; expiresAt: number }
interface ThreadRegistry { revision: number; threads: Record<string, AgentThread> }
```

A claim covers a **file** (`src/a.ts`) or a **directory subtree** when it ends in `/` (`src/features/chat/`). Overlap is symmetric: `src/` conflicts with `src/a.ts`, and a nested `src/chat/` conflicts with an outer `src/`. Expiry bounds every claim, so a killed tab cannot hold a path forever.

---

## 4. Invariants

Numbered because each one is a test, and each one exists because its opposite caused a real failure somewhere:

| # | Invariant | Why |
|---|---|---|
| I1 | A thread writes only to its own branch, and only through a `force: false` ref update | Isolation is the safety mechanism; the ref update is the conflict detector |
| I2 | Claims are granted only inside the cross-tab lock, against the **freshly read persisted** copy | In-memory-only arbitration is exactly how two tabs both "own" a path |
| I3 | Every registry mutation bumps `revision`; a peer message is adopted only when **strictly newer** | Deterministic resolution under races; a skewed clock cannot resurrect a lapsed claim |
| I4 | Claims expire; a heartbeat renews them but never extends beyond the staleness window | Dead tabs release their work |
| I5 | No coordination failure ever blocks a write; unknown threads, bad paths and missing storage all degrade to "no claim" | Coordination is an optimisation, not a gate |
| I6 | Peer input is untrusted: paths, statuses, epochs and claim lists are all validated before entering the model | A malformed or hostile message must not become registry state |
| I7 | The digest is omitted entirely when the session is alone, and self-trims to a budget when it isn't | Awareness must not tax the context of the 95% case |
| I8 | The registry is encrypted at rest, and in-memory-only when the vault is unavailable | It carries conversation labels and intents; plaintext-at-rest would undercut the vault story |

---

## 5. Protocol

```
        ┌──────────── thread A (tab 1) ────────────┐   ┌──────── thread B (tab 2) ────────────┐
        │                                          │   │                                      │
 turn → │ attach(threadId)                         │   │ attach(threadId)                     │
        │ syncFromPeers()      ── hello ───────────┼──▶│ ── registry (revision) ─────────────▶│
        │ upsertThread({branch,intent,status})     │   │                                      │
        │ read digest  ◀── conflicts + peer list   │   │ ◀── digest: A is touching src/a.ts   │
        │                                          │   │                                      │
 edit → │ claimPaths(["src/a.ts"])  ── LOCK ─┐     │   │ claimPaths(["src/a.ts"]) ── LOCK ─┐  │
        │                                   │     │   │                                  │  │
        │   read persisted → grant/refuse ──┘     │   │   read persisted → REFUSED ──────┘  │
        │                                          │   │   (conflict reported, not thrown)   │
        │ heartbeat (renews + republishes)         │   │                                      │
        │                                          │   │                                      │
 push → │ preflight + reviewer warnings           │   │                                      │
        │   "thread B is working on src/a.ts"      │   │                                      │
        │ approval gate → branch → commit → PR     │   │                                      │
        │ releasePaths() / detachThread()          │   │                                      │
        └──────────────────────────────────────────┘   └──────────────────────────────────────┘
```

Storage and transport choices, all reusing existing patterns:

| Need | Mechanism | Precedent in this repo |
|---|---|---|
| Cross-tab mutual exclusion | `navigator.locks.request` (exclusive) | cloud-sync leader election |
| Cross-tab fan-out | `BroadcastChannel`, one whole-doc message per mutation | cloud-sync `intab-cloud-sync` channel |
| Durable state | Vault-encrypted JSON through the IDB key-value layer | `cloud-sync/token-storage.ts` |
| Device identity | `intab_sync_device_id` | `sync-engine.getDeviceId` |
| Tab identity | Random per-document id, never the shared profile id | `TAB_ID` in `sync-engine.ts` |
| Ordering | `revision` / `epoch` counters | revision-based conflict comparison in `sync-engine.ts` |

---

## 6. Integration plan on the current stack

| Phase | Work | Builds on |
|---|---|---|
| **T1 — Registry core** ✅ *done* | `chat/threads/registry.ts`: thread records, path claims, overlap rule, expiry, revision ordering, untrusted-input sanitizer. Pure, clock-injected, 34 tests | — |
| **T1 — Store** ✅ *done* | `chat/threads/store.ts`: encrypted persistence, BroadcastChannel fan-out, Web Locks claim arbitration, degradations. 13 tests, including two tabs racing for one path | I1–I8 |
| **T1 — Awareness** ✅ *done* | `chat/threads/awareness.ts`: the budgeted model digest, the reviewer warnings, presence summaries. 13 tests | — |
| **T2 — Register presence** | Every conversation registers its thread on first tool use: `attach` + `upsertThread({branch: ws.workingBranch ?? ws.branch, intent})`, heartbeat on each turn, `detachThread` on close | T1, `chat.store` workspaces |
| **T3 — Claim the edit set** | Claim paths in the write tools (`write_file`, `edit_file`, `delete_file`), release at turn end; on conflict, inject the conflict digest instead of the generic awareness one | T1, `session/turn-engine.ts`, `workspace/edit.ts` |
| **T4 — Digest into context** | One call in turn preparation: `formatThreadDigest(registry, { selfThreadId, paths, now })`, appended as a low-priority context block ("" when alone) | T1, `context/engine.ts` |
| **T5 — Push-gate warnings** | `formatClaimWarnings(conflictsFor(...))` into the existing `PushWarning[]` list; also warn when another thread's branch touched the same paths since our base | T1, `services/agent-actions.ts` |
| **T6 — Presence UI** | Thread strip: per-thread status, branch, claimed paths, stale marker; click to focus that conversation | T1 `subscribe()`, `chat.store` |
| **T7 — Thread tool** | A `list_threads` tool so the agent can ask for detail the digest trimmed, plus `claim_paths` for planning ahead of an edit | `tool-registry.ts` |
| **T8 — Merge queue** | One integrator (elected with the same Web Locks lease) rebases thread branches onto the trunk, re-runs preflight, requires green checks, then `updateRef(force: false)` with retry on 422; commit trailers carry `Thread-Id:` | T1, `github-write.ts`, CI |
| **T9 — Cross-device** | Mirror the registry through the cloud-sync snapshot store (ETag-conditional write) so a phone sees what the desktop agent is doing | `sync-engine.ts` |

Order matters: T2–T5 are the ones that change behaviour, and all five are small insertions at existing seams. T8 is what turns "several threads" into "one history".

---

## 7. Security

- **The client is not the authority.** Everything here is advisory. The enforcement plane is branch protection, required checks and the push token's scope — a browser tab can lie about its own claims, and no amount of coordination code changes that.
- **Peer messages are untrusted input.** A registry message can arrive from a sibling tab, a future device, or a corrupted store, so `parseRegistry` validates every field and drops what it cannot interpret (I6). Treat a peer's `intent` string as data, never as instructions: it is model-authored text, and it is displayed to *another* model — the same injection surface the preview bridge was hardened against.
- **The registry is encrypted at rest** and reports `memory-only` when the vault is unavailable rather than writing plaintext (I8).
- **Cross-thread awareness widens blast radius.** A shared doc is a shared read surface: it must never carry secrets — no tokens, no file contents, no prompts. Paths, branch names, statuses and one-line intents only.

---

## 8. Positioning

**InTab Threads** — *coordination that costs nothing.*

- **Isolated by construction, aware by design.** Worktree runners give you the first half and leave you reading five terminals; cloud runners give you both and charge a VM per thread.
- **No server, no lease service.** Two browser primitives (Web Locks + BroadcastChannel) plus an encrypted local doc replace the coordination backend competitors have to run.
- **The trunk keeps one writer.** Every integration goes through a compare-and-swap on a git ref, so a lost race is a 422, never a corrupted branch.
- **The browser gates the merge.** The same local runtime that verifies candidates in Forge verifies a rebased thread before it reaches the trunk.
