# InTab Workspace Model — Repo → Workspace → Thread → Run

> **One sentence:** A repository is a shared, cached fact; a chat is a private overlay on top of it; and every piece of async work — a token stream, a preview build, a probe — carries the id of the thread that asked for it, so a background thread can never write into the pane you are reading.

This is the sibling of [Threads](./intab-threads.md). Threads answers *"how do two workstreams on one repository stay out of each other's way?"* — isolation via branches, awareness via a registry. This document answers the layer underneath: **who owns which state, and what may be shown to whom.** Both are only coherent if the identity of a workspace, a thread and a run are distinct things.

---

## 1. The four layers

| Layer | Identity | Lifetime | Contents |
|---|---|---|---|
| **Repo base** | `owner/repo@branch` **+ base commit sha** | Shared by every chat on that repo; survives reload | The tree, and pristine file contents, as GitHub served them |
| **Workspace** | `(conversationId, owner/repo@branch)` | One per chat per repo | The overlay — edited/added/deleted files, undo log, working branch — materialised with the base into the view the agent and preview read |
| **Thread** | `conversationId` | The chat | Messages, plan, summary, model/mode/effort, `repoContext` |
| **Run** | `(conversationId, runId/buildId)` | One in-flight turn / build / probe | Stream chunks, build output, probe results — each tagged with its owner |

The naming rule that keeps this honest: **a workspace is never keyed by its thread alone, and never keyed by its repo alone.** Per-thread-only is what made attaching a second repository silently overwrite the first one's record; per-repo-only is what would let two chats see each other's uncommitted edits.

---

## 2. What was wrong (all three were reported as "the app is broken")

| Symptom | Cause |
|---|---|
| Switching chats re-ran the whole build, and the app lost its state | The preview store was a single slot: `setConversation` **wiped** the document, diagnostics and console |
| A chat sometimes showed *another chat's* app | `setBuild` had no owner, so whichever build finished last won; and the runtime's `inFlight` was global, so a second thread's build was answered with the first's result |
| Attaching a second repo lost the first repo's uncommitted work | The workspace record was keyed by conversation alone — the next save wrote over it |
| Every new chat re-fetched the tree, every file, and every package | Repo-derived state was created per conversation, and there was no module cache across builds |

---

## 3. Invariants

Numbered because each one is a test, and each exists because its opposite caused a real failure:

| # | Invariant | Where it is pinned |
|---|---|---|
| W1 | A build is filed under the conversation that asked for it; a build for a thread that is not on screen is **cached, never rendered** | `preview/preview.store.test.ts` |
| W2 | A status that belongs to a background thread never flips the visible badge | `preview/preview.store.test.ts` |
| W3 | Switching conversations **restores** a build (document, diagnostics, console, delivery) instead of rebuilding it; a never-built thread starts clean | `preview/preview.store.test.ts` |
| W4 | A switch bumps `buildId`, so probe results cannot describe the previous thread | `preview/preview.store.test.ts` |
| W5 | Build run state (in-flight, debounce, last inputs) is per conversation | `preview/preview-runtime.ts` (`BuildSession`) |
| W6 | The repo tree is fetched once per `(repo, branch, base commit)` and shared by every chat | `workspace/repo-base.test.ts` |
| W7 | Pristine contents are shared across chats **only at the same base commit** — a push invalidates them, because "unmodified" is what a diff and a revert act on | `workspace/repo-base.test.ts` |
| W8 | A workspace record is keyed by `(chat, repo@branch)`, and a record whose contents disagree with its key is refused | `workspace/workspace-identity.test.ts` |
| W9 | Deleting a chat deletes every workspace it left behind, and no other chat's | `workspace/workspace-identity.test.ts` |
| W10 | A new chat inherits the active chat's **repo and mode**, and nothing else: it starts from the base commit, not from another thread's dirty files | `stores/chat.store.test.ts` |
| W11 | Package sources are cached by URL identity — the requested URL **and** the post-redirect URL — bounded, LRU | `preview/module-cache.test.ts` |
| W11a | Every published preview is served from **its own origin**, and a request is routed by the `Host` header — so two threads on two repos show two apps, and a frame left pointing at an evicted build is told so rather than handed another one | `host/preview-host.test.ts` |
| W11b | Publishing and releasing are keyed by conversation: rebuilding one thread cannot delete the document another thread is showing | `host/preview-host.test.ts` |
| W11c | Taking a build out of the cache releases the document behind it, keyed by the thread it belonged to | `preview/preview.store.test.ts` |
| W11d | A composer draft is keyed by conversation in the store, so a switch never carries text or attachments into the wrong thread, and a deleted thread's draft goes with it | `stores/chat.store.test.ts` |

### One thread, one repo — and why

| | |
|---|---|
| A **thread** works on exactly one repository at one branch | The write identity is a single working branch feeding a single PR, and the workspace's base commit is that repo's. Multiple repos in one thread would mean multiple bases, multiple branch heads and a diff that cannot be reviewed as one change set |
| Therefore **N repositories = N threads** | Which is not a limitation, it is the point: each thread gets its own workspace, its own pending-change count, its own build cache, its own run state, and now **its own preview origin** — so two repos can be open, built and previewed at the same time, in the same window |
| A shared **repo base** is what keeps that cheap | The tree and pristine contents are fetched once per `(repo, branch, base commit)` and shared by every thread on that repo |
| Not yet true | Thread *claims* are path-scoped, not repo-scoped, so two threads on **different** repos both touching `src/a.ts` would report a conflict that cannot happen. Fixing it is a one-predicate change in the registry, and it belongs with W6 |

W1–W5 are one rule at two layers: **the store decides what may be shown; the runtime decides what may run.** Neither is allowed to assume "the active conversation".

Two further invariants are enforced at the one choke point that owns workspaces (`setWorkspace` / `patchWorkspace` / `ensureWorkspace`), because each was a bug found by writing the layer down:

| # | Invariant | Why it exists |
|---|---|---|
| W12 | The in-memory guard in `ensureWorkspace` reuses a workspace only when it matches the conversation's repo **and branch** | It returned whatever workspace the chat had, so attaching a second repository kept editing the first one's files while every record on disk named the other one |
| W13 | Deleting a chat deletes its workspaces, in memory and on disk, and updates `pendingChanges` without touching the conversation's recency | Records outlived the chat that owned them, and a count that lags behind the files is worse than no count |

---

## 4. Status

| Phase | Work | State |
|---|---|---|
| **W1 — Ownership** | Per-conversation build snapshots, owner-tagged `setBuild`/`setStatus`, frame remount on a thread switch | ✅ done |
| **W2 — Per-thread runs** | `BuildSession` per conversation: in-flight, debounce, last inputs, queued rerun | ✅ done |
| **W3 — Repo base cache** | `workspace/repo-base.ts`: tree + pristine contents, memory LRU + IndexedDB, invalidated by base commit | ✅ done |
| **W4 — Workspace identity** | Record key `(chat, repo@branch)`, index for deletion, contents/key agreement check | ✅ done |
| **W5 — Warm new chats** | `createConversation(model, seed)` inherits repo + mode; shared module cache across builds | ✅ done |
| **W5b — Visibility** | The model in the UI: a repo chip and a change count on every conversation row, the same summary in the header chip, "New chat in owner/repo" on the button that creates one, and a detach/re-attach notice naming the repo whose work is kept | ✅ done |
| **W6 — Overlay split** | Separate the durable overlay from the materialised view, so a workspace can be *forked* (`carry my edits`), diffed against another thread, or handed to the merge queue | next |
| **W7 — Repo switch as a decision** | Attaching a different repo mid-chat: keep it as an explicit choice (carry, discard, or fork a thread) with the dirty-file count in the dialog | next |
| **W8 — Duplicate carries the overlay** | `duplicateConversation` copies the transcript but not the working copy, so the copy shows edits it does not have | next |
| **W8a — Repo-scoped claims** | Presence/claim conflict detection compares paths across threads on *different* repos, which cannot conflict; scope a claim by repo identity | next |
| **W9 — Threads: T2–T5** | Presence, path claims, digests, push warnings — see [Threads](./intab-threads.md); they build on `chat.store` workspaces and are unchanged by this layer | next |

---

## 5. Why the split is the *cheap* version of this

The obvious alternative — one workspace per repo, shared by every chat — is wrong in the other direction: two chats would edit the same files, and a revert in one would silently discard the other's work. Isolation is per thread; the *costs* are per repo. Splitting the state by which of those two facts it depends on is what removes the repeated work without removing the isolation.

It also puts the expensive work where a cache can reach it. A new chat on a repo the user has already opened now costs: one base lookup (miss the tree? no), the files it actually reads, and the packages no previous build fetched. Everything else is already on the machine.
