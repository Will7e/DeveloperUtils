# Runtime Model — Teaching The Agent To Verify, Not Just Assert

Companion to `docs/intab-threads.md` (T1–T9, threads over a repository) and
`docs/intab-workspace-model.md` (the four layers: repo base, workspace,
thread, run). This file covers a different axis: **where code actually runs**,
and what the agent is allowed to claim as verified.

The problem it exists to solve: every tool the agent had *inferred*. It read
a manifest, observed a bundle, queried a DOM. None of them could turn "this
should work" into "this passed", so a change shipped on a promise.

## The tiers

| Tier | Runs | Cost | Status |
|---|---|---|---|
| **T2** local companion | the project's real commands on the user's machine | $0 | **built here** |
| **T3** repository CI | the repository's own workflow, on the pushed branch | $0 to us | **built here** |
| **T4** cloud microVM | same contract as T2, remote adapter | per session-second | not built; opt-in, deliberately last |

The in-pane preview — a client bundle plus a preview host serving it from its
own origin — was **removed**, not maintained. It re-implemented a build
toolchain in the page, so every project quirk had to be re-taught to it, and a
preview that approximates a project is worse than no preview: it looks like
the app and is not. What remains is the direction this file is about — run
the project's own toolchain, in a place that can actually run it.

The ordering is the recommendation, not a roadmap artefact. With a
near-zero compute budget, T2 and T3 between them cover **every repo class in
scope** — JS/TS, Node services with databases, polyglot, native toolchains
and Docker — at zero marginal cost, because both run on compute that already
exists and is already paid for. Cloud buys exactly one thing: *no install
required*.

## T2 — The local companion

The only tier that can run a project's real commands without spending
anything, because the toolchain is already on the user's machine.

| Piece | File | Pinned by |
|---|---|---|
| Command risk classification | `lib/command-policy.ts` | 29 tests |
| Path containment + protected paths | `companion/materialize-plan.ts` | 22 tests |
| Versioned protocol, output shaping | `companion/protocol.ts` | in the above + client tests |
| Real writes, real spawn, timeout kill | `companion/companion-node.ts` | 21 tests (real processes) |
| Pairing, routing, clone-or-overlay trees | `companion/companion-server.ts` | 14 tests (real sockets) |
| Browser client, capability probe | `companion/companion-client.ts` | — |
| `run_command` tool | `services/agent-actions.ts` | registry-consistency guard |

Design decisions worth keeping:

- **Containment is checked twice.** The planner refuses `..`, absolute paths,
  backslashes, drive letters and `.git/**`; the adapter re-checks the
  *resolved* path, because a check that depends on a caller's validation
  disappears the first time a new caller appears. `.git` is blocked because
  it is executable, not data: one write to `.git/hooks/pre-commit` runs on
  the next git command.
- **The kill is a process-group kill.** `npm test` spawns children; killing
  only the shell leaves them running. Output is capped *before* it is held.
- **A failing command is `ok: false` with a result**, never a transport
  error. The exit code is the thing the agent asked for.
- **No companion means not run.** The result says UNVERIFIED rather than
  reporting a pass the tool cannot support.
- **`rm -rf node_modules` is allowed with a warning.** A policy that refuses
  ordinary work gets switched off, and a switched-off check protects
  nothing. The refusals are escalation, credentials, paths outside the tree,
  host-escaping Docker, and anything that publishes — including `git push`,
  which would route around the diff review gate.
- **A partial tree says so.** Given a repository ref the companion checks out
  the base commit and overlays the change set; given only files it writes
  exactly those and every result carries a note that a full test run may
  fail for a missing file rather than a real fault.

Run it: `node src/features/chat/companion/companion-server.ts`, then set
`VITE_COMPANION_ORIGIN` and `VITE_COMPANION_TOKEN` from the printed banner.

## T3 — The repository's own CI

`lib/ci-plan.ts` decides (pure, 21 tests); `lib/ci-client.ts` dispatches and
polls; `verify_with_ci` is the tool. "Free" here means *free to us*: the
repository already declares the toolchain, the secrets and the services, and
GitHub already runs it.

- **Fails closed on triggers.** Workflows are read by pattern, not parsed, so
  a workflow that does not declare `workflow_dispatch` is refused with the
  reason instead of dispatched and waited on forever.
- **The run is found by time, not by position.** A dispatch answers 204 with
  no body, so runs are filtered to those created at or after the dispatch —
  otherwise the previous green run on the same branch is returned and every
  verification passes.
- **A skip is not a pass.** `neutral` and `skipped` map to `unknown` with
  `authoritativelyGreen: false`; a timeout maps to "still running", never to
  a verdict.
- **A 403 is a scope problem.** `actions: write` is not the permission that
  pushes, so the error names that instead of "something went wrong".

## Not wired yet — the honest list

*(Items 1, 2, 4, 5 and 6 were closed after this file was written; what was
fixed is stated with the fix, because a list that only ever grows stops being
read. Items 3 and 7 are still open, and 8 is new.)*

1. ~~**There is no capability-aware router.**~~ **Fixed.**
   `lib/verification-plan.ts` is the decision layer: a pure router over
   `{repoAttached, hasChanges, companion, pushed, evidence}` that returns the
   tiers which can prove this change, which already have, and the one next
   move — with the reason when the answer is "none". It is computed once per
   turn and rides the turn note beside the environment facts, because the
   failure was never that the tiers were missing, it was that the DECISION was
   left to prose. 25 tests, including the case that mattered: a fresh FAILURE
   outranks an older pass.
2. ~~**`run_checks` still reports manifest checks**~~ **Fixed.** It now reports
   the same plan: which tier verified what, what is stale, and what remains
   unrun — so the pane says *who* proved the change rather than listing
   commands that might have run.
3. **The companion cannot answer prompts.** stdin is `ignore`, so a command
   that asks a question hangs until its timeout. A PTY is a real piece of
   work, not a flag.
4. ~~**The pairing token comes from `VITE_COMPANION_TOKEN`**~~ **Fixed.** The
   pairing lives in the encrypted settings store with its own settings tab, and
   resolves settings → env → absent, so an install from before this change
   keeps working while a new one needs no env edit. The companion also answers
   the Private Network Access preflight it was missing — without that header a
   public-origin page is blocked from reaching a loopback companion in current
   Chrome, which would have made every command fail for a reason that looks
   nothing like the cause.
5. ~~**No dependency cache.**~~ **Fixed.** `companion/dependency-cache.ts`
   content-addresses an installed tree by its lockfile hash, so the second
   candidate on a repository reuses the first's `node_modules`. 18 tests.
6. ~~**CI failures are a URL, not a reason.**~~ **Fixed.** A failing run's job
   is read for its log, the failing step and step list are extracted, and the
   tail of the log comes back with the verdict — the URL is still there as the
   citation, but the agent can now act on what CI actually said.
7. **The agent cannot see the running app at all.** With the preview gone,
   runtime behaviour is observable only through what the project's own
   commands report. A loopback URL the user opens themselves is the manual
   version of what the removed pane did.
8. **The companion server is not started by `npm run dev`.** Four separate
   pieces of copy told the model that it was, including a `run_command`
   failure message. It is a separate process
   (`node src/features/chat/companion/companion-server.ts`), and the messages
   now say so. Worth recording *why* it drifted: the Vite plugin that used to
   start it was deleted with the preview host, and the prose outlived the
   plugin by several months — which is the same failure mode as this file's own
   stale claims, and the reason both were audited together.

## Hardening the agent to use them

New tiers the agent does not reach for, or reaches for wrongly, are worse
than none: they add surface and change nothing. Three things were fixed.

**The ledger now records the strongest evidence there is.**
`VerificationKind` gained `command` and `verify_with_ci`'s `ci`, so a real
`npm test` or a real CI run is stored with the revision it describes and
ages out the same way the in-browser kinds do. Two consequences that are the
whole point of the ledger: a passing run followed by another edit is reported
as *stale* rather than as proof, and the PR's proof section is now **derived
from what ran** instead of asserting, unconditionally, that the test suite
was not run — a claim that was about to sit underneath a passing build.

**The claim audit is evidence-based rather than assumption-based.** This was
a real bug, not a refinement. `evidence-audit` flagged every "all tests pass"
as *impossible*, with the message "this workspace has no shell" — true when
it was written, false the moment `run_command` existed. Left alone it would
have fired on honest, passing test runs (training the reviewer to ignore the
audit) while missing a failing one, because only the type check could
contradict a claim. The rules now:

| Claim | Evidence | Outcome |
|---|---|---|
| tests pass | a fresh pass from `run_command` or CI | no finding |
| tests pass | nothing | flagged, naming the two tiers that could run it |
| tests pass | a fresh **failure** | `contradicted-claim`, quoting the first failures |
| tests pass | a pass from before the last edit | flagged as stale, not as proof |

Fixing that surfaced a latent regex bug worth recording: `passes?` matches
"passe"/"passes" and **not "pass"**, so "all tests pass" — the commonest
phrasing there is — never matched the outcome-assertion check at all. Any
contradiction rule built on top of it would have inherited the hole quietly.

**The tool that says what to run no longer says nothing can run.**
`unrunChecksStatement` told the model *"NONE of them can be executed in this
workspace — there is no shell"*. So the one call whose purpose is to decide
what to execute was asserting that execution was impossible, which is why
`run_checks` reliably produced prose. It now names the checks, states that
declaring one is not running it, and points at `run_command` and
`verify_with_ci`.

**A skill turns availability into habit.** `builtin-verification-discipline`
ships in `BUILTIN_SKILLS` (off by default, loadable on demand), teaching the
tier choice, the honesty rules (non-zero IS failure; `authoritativelyGreen:
false` is not a pass; a PARTIAL tree proves less than it looks like; evidence
goes stale on the next edit), what to do when a command is refused, and how
to behave when a fix does not work: read the error, fix the cause, re-run the
SAME command, and after two failures hand back the exact error instead of
inventing a third attempt. Its triggers include the failure phrasings —
"still broken", "doesn't work" — because that is when the discipline matters
most, and it is not the word "verify".

### Why the agent did not reach for any of it

Two things in the prompt, not in the code:

**A standing note forbade it.** `VERIFICATION_LIMIT_NOTE` is injected into
every turn and read *"This workspace has no shell: you cannot run test
suites, linters, type-checkers, or build scripts."* True when written; by the
time it was false it had become the most expensive line in the product — the
agent was told, every turn, that the execution tiers did not exist. The
surviving half is the part that is always true (do not imply a check you did
not run), plus the tiers that can now run one.

**The tool list never mentioned them.** The composed agent prompt documents
its tools by hand and, at the time, stopped at the preview; the guidelines
said verification meant the in-pane observation tools. `run_command`,
`verify_with_ci` and `run_checks` are now documented there, with a guideline
that states the ladder: verify at the strongest tier available, because a
static check cannot prove a build or a test suite passes.

### Skills: 14 shipped, 7 remain, one added back (8)

Seven were retired and `RETIRED_BUILTIN_SKILL_IDS` is what makes that take
effect — `reconcileBuiltins` only ever ADDED, so deleting a builtin changed
nothing for anyone who had already opened the app. Retirement is narrow by
design: a retired skill is removed only when the user left it alone. Deleting
something they had enabled, or edited, would be the harness overruling their
choice. `reconcileBuiltins` had no tests at all, which is how the gap
survived; it has nine now.

| Retired | Why |
|---|---|
| SQL Explainer, Regex Debugger, Docs Simplifier, API Designer | Generic prompt modules. They could be pasted into any chat app; a coding agent in a repository is not asked to do them. |
| Code Reviewer | Superseded by Review This Diff, which does the same severity structure with the workspace tools. |
| Test Writer | Superseded by Add Tests For Change (its coverage guidance was folded in). |
| Commit Writer | The push flow already requires a conventional message and a PR body. |

Three survivors also carried instructions that were **false** by then — Verify
Before Push said the checks could not be run here, Add Tests For Change said
to tell the user the suite could not be executed, and Fix Failing Build only
knew how to re-verify by looking at the page. All three now run the real
thing.

A skill-match never reaches the model, and that is deliberate: the system
prompt prefix must stay byte-stable for provider prompt caching, and the dev
invariant forbids per-turn wire injections. So the index plus `read_skill` is
the intended path, and `SKILL_INDEX_RULE` now says to match on meaning — "it
is still broken", "doesn't work", "fix this" — rather than on the listed
words alone.

## Reading the web — `fetch_url`

Answers that live outside the repository were previously unavailable, so the
agent recalled them: a dependency's API, a breaking change, a spec. Recalled
APIs are a version behind as often as not, and a confident wrong answer about
a library costs more than "let me check".

| Piece | Why it is where it is |
|---|---|
| `lib/web-page.ts` (pure) | URL vetting and HTML-to-text. Refuses non-http(s) schemes **and URLs with embedded credentials** (a secret in a URL gets logged, cached and quoted back). Strips `script`/`style`/comments BEFORE tags, and says in its own output that the structure is approximate — a crude flattening that pretends to be faithful is worse than an honest one, because the model then reasons about tables and layout that were never preserved. |
| `lib/web-fetch.ts` | Two paths: a direct fetch (the only one that can see a redirect chain or a final URL) and the existing `/api/proxy` relay, because CORS means most servers refuse a browser read. `validateUrlForSSRF` runs HERE, before the request, and again server-side on the relay — a redirect can move the target after this side has passed. |
| `untrusted.ts` | `fetch_url` is in `UNTRUSTED_TOOLS`, so a page's words arrive wrapped in `<untrusted-content>` as data. A page is the likeliest of all these routes to carry instructions aimed at the model, because a URL can be chosen to say exactly the wrong thing. |
| `builtin-web-research` | The WHEN. Also the version rule: read the dependency's version from the lockfile FIRST, then the docs for that version. |

Failures are stated rather than thrown: a non-2xx status comes back **with**
its body (an error page is a diagnostic), and a body cut at the byte cap or
the character budget says so. One exception is detected explicitly — a dev
server's SPA fallback returns 200 + HTML + a `<title>` for an unknown path,
so the relay path checks that the response actually came from the relay
before handing back what would otherwise be this app's own page.

Proof over the real stack (`example.com` through the dev relay: 200,
`text/html`, extractor produced `# Example Domain` with no CSS leakage;
`raw.githubusercontent.com/…/README.md`: 200 `text/plain`; metadata endpoint:
**403 `SSRF_BLOCKED`**).

## Ranking the web — `search_web`

`fetch_url` needs a URL. Asking the user for one every time is a worse
product than looking it up, so search was the missing half — and it is the
one capability that cannot live in the browser, because a search key is a
secret.

Four providers, one descriptor each (`lib/search-providers.ts`): Tavily,
Brave, Exa, Serper. They sell the same thing and disagree on everything —
the verb, where the credential goes, the request field names, the response
shape — so the table is the difference between "which key did you get?" and
"which code path do we ship?".

| Piece | Why |
|---|---|
| `lib/search-providers.ts` (pure) | Request building and payload parsing per provider, plus one normalisation pass. `normalizeResults` drops anything the fetch tool could not then open — shape **and** SSRF guard — because a result the agent cannot read is worse than no result: it looks like an answer and cannot be followed. It also strips the `<strong>` markup Brave wraps matched terms in. |
| `lib/search-endpoint.ts` (SERVER-ONLY) | The handler, imported by both entry points so the origin check, provider dispatch, error mapping and throttle exist once. Covers a 12s provider timeout, a per-client 20/min window, and **redaction** — an error body that echoes the key must not reach a log or the model's context. |
| `api/search.ts` | The Vercel edge function. Thin adapter: it only maps a `Request` to the handler. |
| `vite-plugin-api-search.ts` | The same handler in `vite dev`, because that is where the feature will be tested and an endpoint that 404s locally is the worst way to fail. Re-reads `.env` per request, so **adding the key takes effect on the next search, with no restart**. |
| `lib/search-client.ts` | Browser side. Its most important output is not results: `SEARCH_NOT_CONFIGURED` becomes the exact setup step — which env vars enable it, what each free tier is worth, and the one thing not to do (prefix it with `VITE_`, which ships the key to the browser). |

No key configured is **not** an error a user can debug, so it never surfaces
as one. `pickProvider` takes the first key present in order of free-tier
generosity (Tavily, then Brave, Exa, Serper) and `SEARCH_PROVIDER` pins a
choice when several are set.

**Verified, without ever holding a key:** the framework is what makes that
possible. `search-endpoint.test.ts` runs every provider through a stubbed
fetch — dispatch, limits, throttle, timeout, redaction, and a hostile payload
that must degrade to "no results" instead of a crash. Two more checks reach
the real services: an invalid Tavily key came back `Unauthorized: missing or
invalid API key` and an invalid Brave key `SUBSCRIPTION_TOKEN_INVALID` —
proving the URL, verb, header name and body fields are all accepted, with the
credential as the only missing piece. And the `api/` graph was emitted the
way the builder emits it and loaded under plain Node ESM, which is how the
`.js` specifier question (`api/proxy.ts`'s convention) was settled rather
than guessed: extensionless resolves in Vite and fails only in production.

Still unverified: a **successful** search against a real provider. No amount
of local testing covers a valid credential.

A consistency test now pins the class of bug that was found while writing
this: `services/tool-documentation.test.ts` requires every tool in the
registry to be named in the composed prompt. It immediately failed on a
vision tool that had shipped **undocumented** — a tool the model was never
told it had (and one that has since been removed with the preview solution).

### Still not hardened

- **The lean tool profile has no execution tier at all.** This was previously
  written as "gets `run_checks` but not `run_command`", which was simply wrong:
  `LEAN_TOOL_NAMES` carries no verification tool — not `run_checks`, not
  `run_command`, not `verify_with_ci`. So the surface most likely to assert
  rather than check is the one with nothing to check with. It is a one-line
  change, and it is deliberately not made here: handing a weak model a shell is
  a behaviour change that needs an eval showing it *finishes* a verification
  loop instead of looping on it, and `features/chat/evals/` is where that
  answer belongs.
- **A passing `run_command` does not mark the declared checks as satisfied.**
  The ledger records the evidence and the plan reads it, but nothing connects
  `npm test` having run to the manifest's `test` entry saying so — so the plan
  can still say a check "has not been run" on a turn where an equivalent
  command passed under another name.
- **`read_ci_logs` and the CI verdict are two paths to one fact.** The verdict
  now carries the failing log (§6 above), and the tool still exists separately;
  the tool is the one a strong model should prefer, and nothing says so.
