# InTab Forge — Speculation, Proof-of-Behavior & Survivor Fusion

> **One sentence:** Other agents make one model attempt one answer and *hope* it works; InTab Forge seeds **K diverse attempts** across our free-model pool, **runs them in our browser runtime**, keeps only the candidates that **prove they work**, fuses the survivors' shared logic into a solution better than any single model could produce, and **feeds every failure cause back into routing and memory** — at zero marginal model cost.

This is InTab's own technology. It is only *rational* on InTab: it requires free models (to afford K parallel attempts), a browser (to afford a local, instant, private verifier), and a workspace (to have something provable to run). Cursor, Copilot, and Devin have none of these three; Freebuff has free models but no verification-native loop. This document specifies the algorithm, the math, the data model, and the integration path into the agent stack we just shipped.

---

## 1. Why competitors can't copy it

| Competitor | Their loop | Structural weakness |
|---|---|---|
| Copilot / Cursor / generic chat | One model → one patch → user reviews | Pay per token, so parallel attempts are unaffordable; verification = "the LLM said so" |
| Devin-class plan loops | Plan → execute → re-plan on failure | Cloud sandbox = slow, costly verification; failure signals are LLM-judged |
| Freebuff | Free multi-agent "plan, edit, run, verify" | Verification is a single execution pass; no cross-candidate logic, no learned memory |
| InTab today (agent + Learn) | Route well → edit → preview → push | Verification exists but is *reactive* (fix errors after they happen); single-model quality ceiling |

Forge exploits three levers competitors structurally lack:

1. **Free-model economics.** K parallel attempts cost ≈ $0 on the InTab pool. On paid models, K=4 speculation multiplies spend by 4; on InTab it multiplies *quality* at constant cost.
2. **The browser is the oracle.** Our preview runtime (esbuild-wasm + sandboxed iframe + console bridge) executes candidate code locally in milliseconds — deterministic, private, no cloud sandbox queue, no data leaving the user's machine.
3. **We own the ground truth.** Regenerations, aborts, preview errors, and probe outcomes are observed *locally* (the same insight behind InTab Learn) — so the solver can be scored on evidence, not on self-reported confidence.

---

## 2. The Forge Loop — five stages

```
            ┌──────────────────────────────────────────────────────┐
            │                    TASK INTAKE                        │
            │  user prompt + repo context + workspace state         │
            └───────────────┬──────────────────────────────────────┘
                            ▼
      ┌───────────── 1. SEED ─────────────┐   K diversity axes:
      │ Diversity-Seeded Speculation      │   · model family (pool diversity)
      │ K attempts launched in parallel   │   · temperature ladder
      │ on the InTab pool (≈ $0)          │   · plan prior (per-seed strategy)
      └───────────────┬───────────────────┘   · file-selection prior
                      ▼
      ┌───────────── 2. PROVE ────────────┐   Proof-of-Behavior:
      │ Run every candidate in the        │   · esbuild build → typed errors
      │ preview runtime against the       │   · runtime boot probe
      │ Probe Manifest (§3)               │   · behavior probes (props/logic)
      │ No LLM judge — code must RUN.     │   · regression probes (from repo)
      └───────────────┬───────────────────┘   · console cleanliness
                      ▼
      ┌───────────── 3. FUSE ─────────────┐   Survivor Fusion:
      │ Consensus-map the survivors'      │   · agreement on touched files
      │ diffs; splice the strongest       │   · line-level consensus regions
      │ verified synthesis; 3/4 agreement │   · disagreement → judge probe
      │ regions are adopted wholesale.    │     decides by execution
      └───────────────┬───────────────────┘
                      ▼
      ┌───────────── 4. REFINE ───────────┐   Ceaseless Refinement:
      │ If no survivor: fuse every        │   · error taxonomy, not "retry"
      │ failure cause into ONE shared     │   · all K models' lessons fused
      │ context (§2.4) and re-seed with   │   · does not restart from zero
      │ narrower diversity. Budget-bounded│   · escalation ladder, not a spiral
      └───────────────┬───────────────────┘
                      ▼
      ┌───────────── 5. LEDGER ───────────┐   Survivor Ledger:
      │ Record task signature, winner,    │   · feeds InTab Learn bandit
      │ probe results, failure causes →   │   · per-repo solve memory
      │ persisted learning (§5)           │   · next task starts smarter
      └───────────────────────────────────┘
```

### 2.1 SEED — Diversity-Seeded Speculation (DSS)

Single-attempt agents are capped by `pass@1` of their best model. Forge samples the *ensemble*: for a task `t`, launch `K` candidates concurrently, each engineered to be **decorrelated** — because independent failures are what fusion can fix.

Seed vector per candidate `i`:

```
seed_i = ( model_i,      temperature_i,  prior_i,   context_i )
```

- **model_i** — drawn from *distinct model families* in the pool (never two variants of the same family when K is small). Different pretraining = different failure modes = fusion fuel.
- **temperature_i** — a fixed ladder, e.g. `[0.2, 0.5, 0.8, 1.0]`. Low-temp seeds produce "safe" solutions; high-temp seeds explore alternatives fusion can borrow from.
- **prior_i** — a one-paragraph *strategy prior* that differs per seed: "minimal-diff conservative", "component-architecture first", "test-first", "fix the data flow before the UI". Seeds disagree on *approach*, not just wording.
- **context_i** — a file-selection prior: each seed gets the shared repo context plus 1–2 extra files from a rotated heuristic list (importers, previous-editor, sibling components). Candidates see *slightly different slices* of the codebase.

`K` adapts: `K = 2` for trivial single-file edits (probe verdict is cheap), `K = 4` for multi-file features, `K = 6` for tasks the Ledger remembers as hard (prior failures on similar signatures). Always `K ≤ INTAB_HEDGE_MAX_STREAMS × 2` and bounded by pool capacity.

### 2.2 PROVE — Proof-of-Behavior (PoB)

The core belief: **the only unfakeable verifier is execution.** LLM-as-judge produces plausible-sounding, wrong verdicts; PoB produces typed, reproducible evidence. Every candidate patch is installed into a scratch copy of the workspace and executed against a **Probe Manifest** — ordered from cheapest to most discriminating, with early-exit:

| # | Probe | Cost | Catches |
|---|---|---|---|
| P0 | **Build probe** — esbuild-wasm compiles the candidate | ms | syntax, missing exports, type-level breakage |
| P1 | **Boot probe** — module loads in the sandboxed iframe; no throw at import time | ms | broken imports, top-level crashes, SSR/DSO misuse |
| P2 | **Regression probes** — behavior checks *inferred from the reference repo* (§2.3): the app must still do what it did before | ~100ms each | the classic agent failure: fixes the new thing, breaks the old thing |
| P3 | **Intent probes** — checks derived from the user's stated intent, with concrete assertions | ~100ms each | "did the right thing, wrong" |
| P4 | **Property probes** — invariant checks (no `console.error` output during boot; key components render; state round-trips) | cheap | silent rot |

Each probe emits a typed verdict: `pass | fail {errorKind, message, location}`. `errorKind` ∈ `{build, import, runtime, assertion, console, timeout}` — this taxonomy is what makes refinement intelligent (§2.4) and learning durable (§5).

**Anti-gaming rule:** probes assert *observable behavior* (rendered output, DOM presence, returned values, console silence) — never "the code looks right". A candidate cannot pass PoB by being persuasive.

### 2.3 Where probes come from — Test Inference from the Reference (TIR)

Writing tests manually kills autonomy; inventing tests invites LLM-hallucinated assertions. TIR takes a third path, unique to a *workspace with a base commit*:

1. **Regression spec for free:** the base workspace *is* the test suite. We derive P2 probes by executing the pristine workspace once and recording: which routes/components booted, which DOM nodes existed, which console lines appeared. The base's observable behavior becomes the regression contract the patch must preserve.
2. **Intent probes from the user turn:** the seeder asks *one* small pool model (cheap) to convert the user's request into 2–4 concrete assertions (`"search field filters the visible list" → render list, type query, count visible rows changes`), each phrased as a runnable DOM/behavior check, never as code review.
3. **Repo-native checks:** if the repo already has a test runner configured for the browser bundle, its tests are the P2 manifest (highest trust). If not, TIR's derived probes are used (medium trust, still execution-based).

Trust ordering: repo tests > recorded base behavior > inferred intent assertions. The manifest records its provenance and trust level, and the Ledger uses it to weight confidence.

### 2.4 REFINE — Ceaseless Refinement with Fused Failure Context

When all K candidates fail, naive agents retry or give up. Forge **fuses the failure evidence of every candidate into one shared context** and re-seeds with that knowledge injected — refinement that starts from everything the ensemble learned, not from zero:

```
fusedContext = Σ over candidates: {
  candidate i strategy prior,
  furthest probe reached,
  typed error(s): {errorKind, message, location},
  one-line diagnosis written *by that candidate itself* before failing (self-report)
}

re-seed instruction (shared): "K attempts failed. Verified facts:
  - every attempt that reached the boot probe crashed with <kind> at <location>
  - the only candidate that produced rendering reached <probe> and failed on <assertion>
  - no attempt modified <file x>, which P2 traces suggest is involved
  Produce a patch that avoids these verified failure modes."
```

The escalation ladder is budget-aware and logged: `K=2, t-ladder` → `K=4, new families` → `K=4, strategy pivots` (e.g. force a different file-selection prior) → **honest stop** with the typed evidence surfaced to the user ("the intent probe 'filter changes row count' cannot pass — the API the repo uses does not expose filtering; here is what would be needed"). Refinement rounds are capped (default 3) and each round's re-seed *must* cite the fused facts — the loop cannot silently repeat itself.

### 2.5 FUSE — Survivor Fusion

When ≥2 candidates pass all probes, Forge doesn't just pick the winner — it extracts the *consensus*:

1. **Touch-set agreement:** files modified by ≥ ⌈2/3 of survivors⌉ form the consensus touch-set; files touched by only one survivor are inspected for spurious edits (agents love drive-by refactors; consensus kills them).
2. **Region consensus:** for each consensus file, line-level diff regions where a supermajority of survivors made *semantically similar* edits are adopted from the best-scoring survivor wholesale. Divergent regions go to a **judge probe**: the two variants are executed head-to-head against the manifest and the faster/cleaner one wins.
3. **Synthesis fallback:** if survivors each solve different sub-goals correctly (rare but real with strategy priors), one final pool model is asked to *splice* verified pieces — and the spliced result must re-run the full manifest before it's trusted. Nothing enters the workspace unproven.

Fusion is why Forge beats "pick the best of N": ensemble agreement empirically dominates the best single sample (the same mechanism behind SRank / CodeRSA reranking), but Forge's version is *execution-anchored* rather than similarity-anchored, which no text-based reranker can claim.

---

## 3. The Probe Manifest — data model

```ts
interface ProbeManifest {
  taskId: string;
  provenance: "repo-tests" | "base-recording" | "inferred-intent" | "hybrid";
  probes: Array<{
    id: string;
    kind: "build" | "boot" | "regression" | "intent" | "property";
    // DOM/behavior assertion in a tiny declarative DSL, executed
    // inside the sandboxed preview iframe by the bridge:
    //   { "expect": "visible", "selector": "[data-testid='rows']",
    //     "count": { "op": "lt", "value": 10 },
    //     "after": { "action": "type", "selector": "input", "text": "ab" } }
    assertion: Record<string, unknown>;
    trust: number;            // 0..1 — repo 1.0, base-recording 0.8, inferred 0.6
    timeoutMs: number;
  }>;
}

interface CandidateVerdict {
  seedIndex: number;
  modelId: string;
  furthestProbe: string;
  passed: boolean;
  failures: Array<{ probeId: string; errorKind: string; message: string; location?: string }>;
  consoleNoise: number;       // warnings/errors emitted during run
  diff: WorkspaceChange[];    // the candidate's patch, for fusion
  latencyMs: number;
}
```

Execution environment: the preview runtime we already shipped, pointed at a *scratch* workspace (base + candidate diff), with the bridge extended to answer probe assertions via postMessage (it already mirrors console and errors — the DSL runner is an incremental addition). Total added latency per candidate: build (~200ms) + boot + probes ≈ well under a second; K candidates run *concurrently* in separate iframes.

---

## 4. The math — why this beats single-shot

- **Pass-rate lift.** With independent per-attempt success `p`, best-of-K succeeds with `1−(1−p)^K`; at `p=0.45`, K=4 → **0.91**. Decorrelation (family + temperature + prior diversity) is what keeps attempts near-independent — and it's exactly what a paid single-model agent cannot buy.
- **Consensus lift.** Fusion adopts regions agreed by a supermajority, which raises precision above the best survivor: if each survivor is right on a region with `q > 0.5`, a 3-of-4 consensus region is right with `P ≥ Σ C(4,k) q^k (1−q)^{4−k}` over `k≥3 ≈ 0.82` at `q=0.6` — better than the 0.6 best-sample rate on that region.
- **Cost model.** On the InTab pool the marginal cost of K is ~0 (free models, daily caps spread across the pool — which InTab Learn already balances). The only real budgets are *latency* and *pool-capacity*, both handled by adaptive K and the escalation ladder. On a competitor's paid stack this same algorithm multiplies spend by K — which is why they can't follow.

---

## 5. The Ledger — learning that compounds

Every Forge run writes a **Survivor Ledger** entry (persisted, per-repo, alongside InTab Learn):

```ts
interface LedgerEntry {
  taskSignature: string;       // files-touched fingerprint + intent class
  k, rounds: number;
  winner: { modelId: string; seedStrategy: string } | null;
  failingCauses: string[];     // typed errorKinds seen before success
  probeProvenance: string;
  outcome: "solved" | "fused" | "escalated" | "honest-stop";
  userVerdict?: "kept" | "regenerated" | "rejected-after-push";
}
```

Three compounding loops:

1. **Routing (exists — InTab Learn):** `winner.modelId` and failure records sharpen the per-(model, turnKind) bandit; Forge's K-parallel runs generate far more learning signal per minute than the single-stream loop did.
2. **Seeding (new):** for a repeat task signature (same repo area, similar intent), the Ledger biases seed priors toward past-winning strategies and away from failure patterns ("the last 3 attempts touching `payments/` failed on boot imports — raise P1 strictness, add import graph to context").
3. **Probe reuse:** recorded base-behavior manifests are cached per (repo, commit) — later tasks on the same repo inherit a richer regression contract, making verification *stronger over time* at zero extra cost.

The user-visible effect after a few sessions: the agent fails less on *their* repos, in *their* frameworks, with *their* conventions — an edge that is literally made of their own history and cannot be cloned by a competitor with a generic model.

---

## 6. Integration plan on the current stack

| Phase | Work | Builds on |
|---|---|---|
| **F1 — Manifest & bridge DSL** | Probe Manifest type + declarative assertion runner inside the preview bridge (`preview-bridge.ts`, `preview-runtime.ts` scratch-workspace builds) | preview runtime ✅ |
| **F2 — Seeder** | `forge/seeder.ts`: K candidates from pool families × temperature ladder × strategy priors; parallel `streamChat` calls (reuse hedged-race plumbing) | chat-runner ✅, intab-llm pool ✅ |
| **F3 — PoB executor** | `forge/prove.ts`: run manifest per candidate in scratch iframes; typed verdicts; early-exit ordering | F1 |
| **F4 — Fusion** | `forge/fuse.ts`: touch-set + region consensus, judge probes for disagreements | F3, workspace diff ✅ |
| **F5 — Refinement ladder** | fused-failure re-seed with round caps + honest-stop surface | F2, F3 |
| **F6 — Ledger** | `forge/ledger.ts` persistence + InTab Learn hookup + seeding bias | intab-learn ✅ |
| **F7 — UX** | Forge panel: candidate strip (K attempts, probe badges), fusion explanation, honest-stop evidence | PreviewPane ✅ |

The agent keeps its existing contract — the user still sees one answer and one approval gate. Forge is the machinery *behind* the curtain: what arrives for review is a probe-passing, consensus-fused patch, and the preview they watch live is running the survivor.

---

## 7. Name & positioning

**InTab Forge** — *"proof-of-behavior solving."*

Marketing line for the site: **"Other agents guess. Forge makes candidates prove they work — in your browser, before you ever see them."**

Three bullet defensibility story:
- **Free-model speculation** — 4 parallel attempts where others can't afford 1.
- **Browser-native verification** — the oracle is local, instant, and private; no cloud sandbox, no LLM judge.
- **A memory made of your own history** — routing, seeding, and probes all learn from every solve, per repo.
