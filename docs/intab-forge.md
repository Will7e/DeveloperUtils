# InTab Forge — Speculation, Proof-of-Behavior & Survivor Fusion

> **Status: proposal. Nothing in this document is shipped, and this file was
> wrong the last time it was written.**
>
> The previous revision described the in-page preview runtime (`preview-runtime.ts`,
> the five-file preview host, `PreviewPane.tsx`), Forge's `preview-bridge` probe
> runner, and the InTab Learn router as ✅ shipped, and called the browser "the
> oracle" as the core moat. Those pieces were **deleted** — see §1. A document
> that advertises code which no longer exists is not a roadmap, it is a trap: it
> was enough to misdirect the first read of this repository, and it will
> misdirect the next plan written from it. What follows is the same algorithm
> re-anchored on the execution tiers that actually exist today.

> **One sentence:** Instead of one model attempt and a hope, seed **K diverse
> attempts**, **run each one against a real execution oracle**, keep only the
> candidates that prove they work, fuse the survivors' shared logic, and feed
> every failure cause back into the next seed — with the oracle choosing task
> class, not the other way round.

The premise has not changed: verification-by-execution beats verification-by-
persuasion, and parallel decorrelated attempts beat one attempt when the marginal
attempt is cheap. What changed is *where execution happens* in this app, and that
single fact decides which tasks Forge may ever be pointed at.

---

## 1. What was removed, and what it costs this spec

| Removed | Where it went | What it takes from Forge |
|---|---|---|
| `preview-runtime.ts` (1,434 lines) — esbuild-wasm + in-page module resolution | deleted in `e9144b4` ("remove preview feature") | the millisecond verifier. Build and boot probes ran in the page, per candidate, for free. |
| the preview host (`preview-host/*`, 1,352 lines) + `preview-bridge` + `PreviewPane` | same commit | probe assertions via `postMessage`, and the candidate-strip UI they would have reported into |
| module resolver (`graph`/`glob`/`aliases`/`module-resolution`, ~1,900 lines), `css-pipeline`, `vfs`, `bundle`, `cdn`, `env`, `entry`, `document`, `preload` | same commit | the ability to run *any* candidate without an install step |
| the InTab Learn router (bandit over provider outcomes) | removed earlier | the routing half of the Survivor Ledger (§5), which was supposed to consume `winner.modelId` |
| `src/preview-frame.html`, `src/preview-harness.html` | moved to `docs/qa/` | nothing — they were reverted QA scratch, not runtime |

**Why it was deleted, in one line: it re-implemented a build toolchain inside the
page, so every project quirk had to be re-taught to it, and a preview that
*approximates* a project is worse than no preview — it looks like the app and is
not.**

That is the fragility finding this document exists to record, because it is
larger than one feature. The visual/verification layer has been rebuilt and
discarded more than once in this codebase, each time for the same reason: a
second, approximating implementation of something the project already owns (its
bundler, its module resolution, its CSS pipeline, its dev server). The rule that
follows is the design constraint for everything below:

> **One interpreter of "it works" per tier.** The app may *own* a verifier — the
> browser workspace (T2) runs the project's real commands in this tab,
> `verify_with_ci` (T3) runs the repository's own workflow — but it must never
> ship a second implementation that guesses how the project would build. Anything
> that needs the project's toolchain gets delegated to the project's toolchain.

For Forge, the consequence is concrete and uncomfortable: **the oracle is no
longer free or instant.** Every candidate costs a real command or a real CI run,
which prices the loop below in seconds and minutes rather than milliseconds. So
Forge's first requirement is not K, or fusion, or a ledger — it is *a task class
with a cheap oracle*.

---

## 2. The oracle ladder (what can actually prove a candidate today)

`lib/verification-plan.ts` already answers "which tier can prove this change, and
has one?" — a pure router over the repository, the change set, the workspace's
state, the push state and the verification ledger. Forge's prover must be *that
router applied per candidate*, not a new abstraction beside it: the day there are
two answers to "what can prove this", one of them will be wrong.

| Probe | Tier | Cost | Proves | Catches |
|---|---|---|---|---|
| **P0 Static** | in-page typecheck (`run_checks`) | ~ms / ~s | compiles, types line up | syntax, missing exports, type-level breakage |
| **P1 Build** | browser workspace: the project's own build command | seconds | the project still builds | config, entry points, asset/bundler breakage |
| **P2 Tests** | browser workspace: the project's own test command | seconds–minutes | behaviour the repo already asserts | **the classic agent failure: fixes the new thing, breaks the old thing** |
| **P3 Intent** | browser workspace: a command the *user's request* implies | seconds–minutes | the requested behaviour, not just a green suite | "did the right thing, wrong" |
| **P4 CI** | `verify_with_ci` on the pushed branch | minutes | the repository's definition of done, with its secrets and services | everything the local tree approximates |

Three properties of this ladder decide the design:

1. **P0–P2 are the only per-candidate probes.** P4 is authoritative and far too
   slow to run K times; it is the *final gate on the survivor*, not a probe.
   A candidate that has not cleared P0–P2 must never be sent to CI.
2. **P3 is the probe nobody has.** Nothing in the repo generates it. This is the
   real gap between "the tests pass" and "you did what I asked", and it is where
   a small model *is* worth spending on — converting the user's sentence into two
   or three runnable assertions, not judging the code.
3. **Refusals are evidence.** "Toolchain absent", "no test script", "no
   `workflow_dispatch` trigger", "no dependency install possible" are all cases
   the router already reports by name. A candidate set that cannot be probed must
   be reported as **unproven**, never as passing.

### 2.1 What this means for K

- **Eligible tasks only.** K candidates are affordable where a cheap oracle
  exists (a pipeline task with a typecheck, test or build command). For tasks
  with no oracle, Forge degrades to what the agent does today: one attempt, and
  honesty about what was not proven.
- **K is bounded by the oracle, not by ambition.** Speculation pays when
  `latency(candidate) ≪ latency(whole attempt)`; with a per-candidate P1/P2 run
  in the seconds, `K = 2–4` concurrent trees is the plausible band. Anything
  priced in CI minutes makes the fusion maths a fiction.
- **Cost is no longer ~0 in the way this document used to claim.** Model tokens
  may be free on this pool; *verification* is not (machine time, CI minutes,
  the user's CPU). The honest budget line is the oracle's.

---

## 3. The loop

```
 TASK INTAKE
   user request + repo + change-set
        │
        ├── 0. ELIGIBILITY ── verification-plan router ──▶ no oracle? STOP (one attempt)
        ▼
   1. SEED     K candidates, decorrelated: model family × temperature × strategy prior × file-slice
        ▼
   2. PROVE    P0 static → P1 build → P2 tests, per candidate, early-exit on first typed failure
               (typed verdict: {pass | fail{errorKind, message, location}})
        ▼
   3. FUSE     ≥2 survivors? adopt touch-set + region consensus; disagreement → P3 intent probe
        ▼
   4. REFINE   no survivor? fuse EVERY candidate's typed failure + self-diagnosis into one context,
               re-seed narrower (bounded rounds, then an honest stop with the evidence)
        ▼
   5. GATE     the survivor goes through the EXISTING approval gate: diff, warnings, preflight,
               verification-ledger lines, push → then P4 CI
        ▼
   6. LEDGER   record task signature, seeds, failing causes, survivor, and what the user did with it
```

Stages 2, 5 and 6 are anchored in code that exists today: the ledger (§5), the
push gate with its reviewer warnings, and the verification ledger that stores
evidence *against a revision* so a pass followed by another edit reads as
**stale** rather than as proof. Stage 1, 3 and 4 are the unbuilt part.

### 3.1 Typed failures are the whole point of §4

`errorKind ∈ {static, build, test, intent, timeout, unknown}` — because "retry"
and "refine" are different actions, and a fused failure context is only useful if
each failure says *what kind of wrong* it was and *where*. A round that cannot
cite what the previous round proved is a loop, not a refinement.

### 3.2 The anti-gaming rule

Probes assert **observable behaviour** — exit codes, produced artifacts, command
output, and for P3 the assertions derived from the user's sentence. Never "the
code looks right", and never a model's opinion of the diff. If a probe cannot be
expressed as something a command decides, it is not a probe; it is a review, and
it belongs in the gate's warnings where a human sees it.

---

## 4. Fusion, and when not to do it

> **Do not build the fuser before the oracle.** The last Forge design leaned on a
> consensus-fusion loop with no execution verifier behind it, which is a machine
> for producing confident unaccountable patches — and it is exactly why that
> version could not be maintained. Fusion is stage 3, not stage 1.

When ≥2 candidates survive the same probe set:

1. **Touch-set agreement.** Files edited by at least two thirds of survivors are
   the consensus set; singletons are inspected as suspected drive-by edits.
   Without execution, this heuristic is all you have — with P2 behind it, an
   unproven singleton is simply dropped rather than argued about.
2. **Region consensus**, adopted from the best-scoring survivor; divergent regions
   are decided by **running both** against P2/P3, not by voting.
3. **Synthesis fallback** (survivors solving different sub-goals): a final splice
   is allowed, and the spliced result must re-run the full probe set before it is
   trusted. Nothing enters the workspace unproven.

Note what is left of the old "ensemble agreement dominates best-of-N" claim once
the oracle is not instant: agreement is a *routing* signal (which survivor's
region to try first), not a proof. The proof is still the command.

---

## 5. The ledger

What exists: `lib/verification-ledger.ts` — evidence recorded per conversation
against a **revision** of the workspace, with kinds (`typecheck`, `command`,
`ci`), age, and staleness; consumed by the turn note, the push gate and the
header chip. That is the primitive the Survivor Ledger would extend:

```ts
interface LedgerEntry {          // proposal — not implemented
  taskSignature: string;         // changed-file fingerprint + intent class
  k: number; rounds: number;
  survivor: string | null;       // for the transcript's sake, not for routing
  failingCauses: string[];       // typed errorKinds seen before success
  oracle: "workspace" | "ci" | "static" | "none";
  outcome: "solved" | "fused" | "escalated" | "honest-stop";
  userVerdict?: "kept" | "regenerated" | "rejected-after-push";
}
```

Two honest caveats. The router this data used to feed (the Learn bandit) is gone,
so today the ledger's consumers are the prompt, the gate and the chip — a
`taskSignature → seed prior` bias has no consumer until a router exists again.
And `winner.modelId` is the kind of per-model scoring that made the retired router
drift: prefer recording *what proved the change* over *who wrote it*.

---

## 6. Staging, in dependency order

| Phase | Work | Needs | Status |
|---|---|---|---|
| **F0 — Oracle** | One task class with a cheap, real verifier end to end: workspace P1/P2 on a JS/TS repo, with typed verdicts and honest refusals | browser workspace ✅, `command-policy` ✅, verification-plan ✅ | **the only prerequisite** |
| **F1 — Candidate runner** | K candidate workspaces, one candidate per workspace, run P0→P2, early exit, collect typed verdicts | F0, `materialize-plan` ✅ | not built |
| **F2 — Seeder** | Model family × temperature ladder × strategy prior × file slice; parallel stream calls | F1 | not built |
| **F3 — Refinement** | Fused typed-failure re-seed, round cap, honest stop | F1, F2 | not built |
| **F4 — Fusion** | Touch-set + region consensus, head-to-head probes for divergence | F3 | not built |
| **F5 — P3 intent probes** | The user's sentence → 2–3 runnable assertions; the missing half of "did what I asked" | F1, a small model | not built |
| **F6 — Ledger** | Extend the verification ledger with seed attribution | F1 | not built |

---

## 7. What Forge is not

- **It is not a reason to rebuild the preview.** Running the project's own
  toolchain (T2/T3) is the direction; an in-page approximation of one is the
  thing we already removed once.
- **It is not a way to skip the gate.** The survivor arrives at the same
  approval dialog as any other change, with the same preflight, the same
  evidence audit, and now also the same cross-thread warnings when another agent
  thread holds one of the paths.
- **It is not honest without its refusals.** A run with no available oracle must
  say so in those words. "K candidates, none verified" is a real outcome and the
  one users most need to see.
- **It is not for every task.** Where no command can decide the outcome, the
  correct behaviour is the current one: one attempt, and a summary that does not
  imply a check that never ran.
