// ============================================================
// Tool Contracts — The Decision Each Tool Represents
// ============================================================
// The registry (tool-registry.ts) declares what a tool IS: its wire schema,
// how it executes, whether it is plan-safe, how its activity row reads. It
// does not say WHEN to reach for it, HOW to call it, or which sibling it gets
// mistaken for — and that is the knowledge an agent actually needs at the
// moment it chooses. That knowledge used to live in three hand-written prose
// blocks in services/turn-prep.ts, where a tool could be added to the
// registry and documented nowhere (or documented as available on a turn that
// never offered it) without a single test failing.
//
// So each tool now declares its own decision, here, next to the others:
//
//   when        the signal in the request or the environment that makes this
//               the right tool. Written as a condition, not a slogan.
//   how         the canonical call — the shape that works first time.
//   insteadOf   the sibling it is confused with, plus the discriminator that
//               separates them. This is what the harness quotes back when a
//               call fails, so a mistake teaches the next move.
//   misuse      the failure mode observed in practice, and the correction.
//   proves      (optional) where the evidence stops — a green `run_code`
//               proves the snippet, never the project.
//   effects     what the world sees, in one of five tiers.
//   autonomy    the gate policy: act / undoable / ask / blocked.
//   sensitivity which data class it reads or writes (lib/sensitivity.ts).
//
// The type is a total Record over ToolName, so ADDING A TOOL TO THE UNION
// FAILS TO COMPILE until its contract exists — the join between the two
// tables is enforced by the compiler rather than by a checklist. The runtime
// test (tool-contracts.test.ts) covers what types cannot: that no field is a
// placeholder, and that two tools in the same confusion group do not hand the
// model the same discriminator.
//
// Pure and side-effect free: types and strings only, so every layer (prompt
// composition, the turn engine's failure hints, the tests) can read it.
//
// Prose generation lives at the bottom (bulletFor / bulletsFor): the prompt
// blocks are DERIVED from this table, so documentation cannot drift from the
// decision it describes.

import type { ToolName } from "../types";
import type { SensitivityClass } from "./sensitivity";

/** What the world sees when a tool runs */
export type ToolEffect =
  /** Reads only — nothing outside this conversation changes */
  | "none"
  /** Changes the agent's working copy (reversible until a push) */
  | "workspace"
  /** Changes this app's own stored data (files, sessions, boards, settings) */
  | "app-data"
  /** Reaches something the user owns OUTSIDE this app (a machine, a service) */
  | "external"
  /** Moves the user's screen: switching tools, drawing on a canvas */
  | "user-view";

/**
 * The gate policy, in one word. This is the whole permission model:
 *
 *   act        do it. Reads and locally-computed answers.
 *   undoable   do it, record it in the action ledger, offer an undo.
 *   ask        the user decides first — irreversible, or reaching outside.
 *   blocked    not available to the agent at all (this app's own credentials).
 */
export type ToolAutonomy = "act" | "undoable" | "ask" | "blocked";

export interface ToolContract {
  when: string;
  how: string;
  insteadOf?: { tool: ToolName; discriminator: string };
  misuse?: string;
  proves?: string;
  effects: ToolEffect;
  autonomy: ToolAutonomy;
  sensitivity: SensitivityClass;
}

export const TOOL_CONTRACTS: Readonly<Record<ToolName, ToolContract>> = {
  // ── Repository discovery and reading ──────────────────────
  get_repo_overview: {
    when: "you have just been pointed at a repository you have never seen",
    how: "get_repo_overview({}) — no arguments. Then list_repo_files on the subtrees that matter.",
    insteadOf: {
      tool: "list_repo_files",
      discriminator: "choose this one when you do not yet know what the project IS, not merely where a file is",
    },
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  list_repo_files: {
    when: "you can name the area of the project but not the file",
    how: 'list_repo_files({ subtree: "src/features" }) — omit subtree for the root.',
    insteadOf: {
      tool: "get_repo_overview",
      discriminator: "choose this one when you know the area to look in and want the paths under it",
    },
    misuse: "a tree is not a search: if you know the text, search for it instead of reading paths",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  find_files: {
    when: "you know what the file is CALLED, or the shape of its name, but not where it lives",
    how: 'find_files({ pattern: "**/*.test.ts" }) — a pattern with no slash matches a filename at any depth, so "*.spec.ts" finds specs anywhere.',
    insteadOf: {
      tool: "search_workspace",
      discriminator: "choose this one for a NAME: it matches the path. search_workspace matches the CONTENT inside files",
    },
    misuse:
      "a glob is not a regex: * stops at a path separator and ** crosses them, so use ** only when you mean to search below the directory you named",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  read_files: {
    when: "you already know which files a question needs and want them in one round trip",
    how: 'read_files({ paths: ["src/a.ts", "src/b.ts"] }) — up to 12 whole files, within one shared result budget.',
    insteadOf: {
      tool: "read_file",
      discriminator: "choose this one for SEVERAL known paths at once; read_file takes one path and can window it with startLine/endLine",
    },
    misuse:
      "this is not a search: if you do not know the paths, find_files or search_workspace first. A file too large to fit the shared budget comes back listed as not-read rather than truncated",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  read_file: {
    when: "you know the path and need what the file says",
    how: 'read_file({ path: "src/App.tsx" }) — add startLine/endLine for a large file. Paths are repo-relative.',
    insteadOf: {
      tool: "search_workspace",
      discriminator: "choose this one when you already know WHICH file; search when you only know the text",
    },
    // `read_files` is the batched sibling: "several known paths" is its job, and
    // this one is the windowed single-file read. Naming it here is what makes a
    // model that needs five files reach for one call instead of five.
    misuse:
      "one good window beats five tiny slices — a 20-line slice at a time burns the turn. Read a few hundred lines around what you need, and never rewrite a file you have only partly read.",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  search_workspace: {
    when: "you know the text, symbol or pattern but not which file holds it — including code you edited yourself this turn",
    how: 'search_workspace({ query: "parseToolArguments", mode: "text" }) — pathPrefix narrows it, mode "regex" for a pattern.',
    insteadOf: {
      tool: "search_code",
      discriminator: "choose this one for the working copy: it sees your own unpushed edits and is not rate-limited",
    },
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  search_code: {
    when: "you are exploring a repository you have not edited, or your edit added the text you are looking for",
    how: 'search_code({ query: "createWorkspace" }) — scoped to the attached repo automatically.',
    insteadOf: {
      tool: "search_workspace",
      discriminator: "choose this one to explore untouched repository history, or to look up the ORIGINAL text of a file you have since edited",
    },
    misuse: "this searches GitHub's index, not your working copy: it cannot see your unpushed edits",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  run_tool_program: {
    when: "you already know the three-to-eight read-only calls you want and would otherwise emit them one round at a time",
    how: 'run_tool_program({ program: [{ read: "a", tool: "read_file", args: { path: "src/a.ts" } }, { tool: "search_workspace", args: { query: "$a" } }] })',
    misuse: "only read-only tools may be steps; nothing here edits, runs or ships",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  get_workspace_diff: {
    when: "you need to see your own change set — before a push, or after a compaction folded the earlier turns away",
    insteadOf: {
      tool: "diff_text",
      discriminator:
        "choose this one for YOUR OWN change set, which knows the base commit and every file you touched; diff_text only compares two strings someone handed you",
    },
    how: 'get_workspace_diff({}) for everything changed, or get_workspace_diff({ path: "src/App.tsx" }) for one file.',
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  read_skill: {
    when: "a task matches a skill in the Available Skills index and you have not loaded it yet (its triggers, or the kind of work you are doing)",
    how: 'read_skill({ name: "Probe An API" }) — cheap; loading two or three relevant skills up front makes the rest of the turn more accurate.',
    misuse: "asking the user how to do something a loadable skill already documents is the failure this tool exists to prevent",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  // ── The agent's working copy ──────────────────────────────
  edit_file: {
    when: "you are changing part of a file you have read — which is almost always",
    how: 'edit_file({ path, oldString, newString }) where oldString is the exact existing text including indentation and enough context to be unique.',
    insteadOf: {
      tool: "write_file",
      discriminator: "choose this one to change a region; write_file replaces the WHOLE file and deletes anything you did not reproduce",
    },
    misuse:
      "a failed match is not a reason to reach for write_file — re-read the region and use the exact text, because writing the whole file from memory destroys what you did not see",
    effects: "workspace",
    autonomy: "undoable",
    sensitivity: "project",
  },
  write_file: {
    when: "the file does not exist yet, or you have read it in its entirety and are replacing all of it",
    how: 'write_file({ path, content }) where content is the COMPLETE file text — anything omitted is deleted.',
    insteadOf: {
      tool: "edit_file",
      discriminator: "choose this one when the file is new, or when every line of it is being rewritten deliberately",
    },
    misuse:
      "writing a whole file from a partial read is the single most destructive thing an agent does — if you have not seen all of it, edit instead",
    effects: "workspace",
    autonomy: "undoable",
    sensitivity: "project",
  },
  delete_file: {
    when: "the user asked for a file to be removed, or code is being genuinely retired rather than moved",
    how: 'delete_file({ path }) — a tombstone in the working copy until a push.',
    misuse: "deleting is rarely reversible in review: prefer emptying or editing when the intent is a refactor",
    effects: "workspace",
    autonomy: "undoable",
    sensitivity: "project",
  },
  remember: {
    when: "you learned a durable, repo-specific fact that the next conversation would otherwise rediscover — a build command, a convention, a gotcha",
    how: 'remember({ fact: "One sentence of durable fact." }) — repo-specific, one line, never task progress or secrets.',
    effects: "workspace",
    autonomy: "undoable",
    sensitivity: "project",
  },
  delegate: {
    when: "a research question would flood your context with file bodies you do not need to keep — 'map every usage of X', 'how does Y work'",
    how: 'delegate({ task: "State the DELIVERABLE: which files, which symbols, which line ranges." }) — free to choose the approach; it returns a report, not edits.',
    insteadOf: {
      tool: "search_workspace",
      discriminator: "choose this one when the searching itself is the bulk of the work; search directly when you want two or three hits yourself",
    },
    misuse: "the helper is read-only and can be wrong: verify anything you are about to act on before you rely on it",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  // ── Executing and verifying ───────────────────────────────
  run_code: {
    when: "the answer is what a snippet DOES — a regex, a date calculation, a sort order, a SQL query, a decimal rounding, an edge case",
    how: 'run_code({ language: "typescript", code: "console.log(...)" }) — include the print that reports the result.',
    insteadOf: {
      tool: "run_command",
      discriminator: "choose this one to check LOGIC in a sandbox with no project files; run_command is for proving the project itself",
    },
    misuse:
      "no filesystem, no node_modules, no network files — if the snippet needs a dependency, inline the logic instead of importing it",
    proves:
      "a green snippet proves the snippet's logic and nothing else. It does NOT mean the repository builds or that its tests pass.",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  run_checks: {
    when: "you need to know what this repository DECLARES must be verified, or you want the workspace type check after editing TypeScript",
    how: 'run_checks({}) to report and type-check; run_checks({ run: true }) to also execute the declared checks on the configured runner.',
    proves:
      "the type check runs over the workspace's own sources with third-party types erased, so it cannot catch a mistake inside a dependency API. Tests, lint and build still need a runner.",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  run_command: {
    when: "you are verifying a change for real — install, build, test, lint, typecheck, a script — or the task is inherently a command",
    how: 'run_command({ command: "npm test -- --run", why: "proves the new parser tests pass" }) — one line in `why`, and pass non-interactive flags so nothing waits on a prompt.',
    insteadOf: {
      tool: "run_code",
      discriminator: "choose this one when the PROJECT has to build or its own tests have to run; run_code only tests a snippet",
    },
    misuse:
      "a non-interactive flag is mandatory (-y, --yes, --no-input): a command that stops to ask a question hangs the turn. Long-running work (a dev server) has no business here.",
    proves:
      "only a zero exit code proves the run passed. Non-zero IS failure — quote the first failure lines rather than paraphrasing them, and re-run the SAME command after a fix.",
    effects: "external",
    autonomy: "act",
    sensitivity: "project",
  },
  verify_with_ci: {
    when: "the change is pushed and you need the repository's own CI verdict — the authoritative green for the pull request, and the only tier that covers Python, Rust, Docker or service-backed projects",
    how: 'verify_with_ci({ workflow: ".github/workflows/ci.yml" }) — maxWaitMs if the run is slow.',
    insteadOf: {
      tool: "run_command",
      discriminator: "choose this one when the project's own workflow is the definition of green, or the toolchain is not JavaScript",
    },
    proves:
      "a skipped, neutral or still-running run verified nothing. Only `authoritativelyGreen` is a pass, and it describes the PUSHED revision.",
    effects: "external",
    autonomy: "act",
    sensitivity: "project",
  },
  // ── GitHub collaboration: the conversation around the code ─
  list_issues: {
    when: "you need to find an issue by area or label before reading one, or to check whether the defect in front of you is already filed",
    how: 'list_issues({ labels: "bug", state: "open" }) — one flat object; PRs are excluded unless you ask for them.',
    insteadOf: {
      tool: "list_pull_requests",
      discriminator: "choose this one for reports of defects and work requests; pull requests are code proposals, and GitHub's issues list hides them by default here",
    },
    misuse:
      "a list row is a title and a preview — read_issue before you claim what a thread says",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  read_issue: {
    when: "an issue number is known and its thread may already contain the decision, the reproduction or a maintainer's constraint on the fix",
    how: "read_issue({ number: 42 }) — the body plus the LAST 20 comments, which is where a thread's current state lives.",
    insteadOf: {
      tool: "read_pull_request",
      discriminator: "choose this one for a numbered thread about a PROBLEM; read_pull_request is for a proposed change and its reviews",
    },
    proves:
      "the thread is what its participants said, not what the code does — verify a claim in the issue against the repository before acting on it.",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  list_pull_requests: {
    when: "you need a pull request's NUMBER — most often to find the one for the branch you just pushed, or to see what is already open before opening another",
    how: 'list_pull_requests({ head: "agent/fix-login" }) — `head` is the source branch and matches only this repository.',
    insteadOf: {
      tool: "read_pull_request",
      discriminator: "choose this one to find the number; read_pull_request needs the number already and gives the review, files and checks",
    },
    misuse:
      "opening a second pull request for a branch that already has one is never the fix — list first, then push to the open one",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  read_pull_request: {
    when: "a review, a red check or a changed description is what a task turns on — 'fix what the reviewer asked for', 'why is CI red on my PR'",
    how: "read_pull_request({ number: 17 }) — the result carries a `verdict` block (checks, blocking reviewers, inline-comment count, mergeability) and `inlineComments` with the id each reply needs.",
    insteadOf: {
      tool: "get_workspace_diff",
      discriminator: "choose this one for what is ON GITHUB (reviews, comments, checks); get_workspace_diff shows your own unpushed working copy",
    },
    proves:
      "the check RUNS on the PR's head commit, not a verdict on your local working copy: green says the pushed revision passed, never that an uncommitted edit is fine.",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  read_ci_logs: {
    when: "a workflow failed and you need the failing job, step and error lines — including a run you did not dispatch, e.g. a red branch you were asked to fix",
    how: "read_ci_logs({}) — newest failed run on this thread's branch; or read_ci_logs({ runId: 123 }) for a specific one.",
    insteadOf: {
      tool: "verify_with_ci",
      discriminator: "choose this one to read WHY a run failed; verify_with_ci DISPATCHES a run and reports whether the pushed change passes",
    },
    proves:
      "the lines are the job's own output. A deduplicated error line says what the job printed, not that the same cause applies to your current edit.",
    effects: "none",
    autonomy: "act",
    sensitivity: "project",
  },
  create_issue: {
    when: "you found a real defect that is NOT the task you were given, and the user's request implies it should be tracked",
    how: 'create_issue({ title: "Login fails when the email has a +tag", body: "…steps, expected, actual…", why: "found while fixing the session bug" }) — the user approves it first.',
    misuse:
      "never file an issue about your own in-progress work, and never to narrate a status. Filing is public and permanent enough that it is the user's decision, which is exactly why they are asked",
    effects: "external",
    autonomy: "ask",
    sensitivity: "project",
  },
  comment_on_issue: {
    when: "an issue or pull request thread asked something you can answer, and the answer belongs on the thread rather than in the transcript",
    how: 'comment_on_issue({ number: 42, body: "…" }) — same endpoint for issues and PR conversation; the user approves the text. Answering a specific inline note takes `replyToCommentId` from `read_pull_request`.',
    insteadOf: {
      tool: "review_pull_request",
      discriminator: "choose this one to REPLY in the conversation; review_pull_request submits a formal review state that can block a merge",
    },
    misuse:
      "never comment to report your own progress, and never post a comment the user has already declined with a note — adapt to the note. A reply that says only 'fixed' wastes the reviewer's time: name what changed, or the push that changed it",
    effects: "external",
    autonomy: "ask",
    sensitivity: "project",
  },
  review_pull_request: {
    when: "a pull request needs a formal verdict that others will act on — approval, or a blocking request for changes with the reason",
    how: 'review_pull_request({ number: 17, event: "REQUEST_CHANGES", body: "…" }) — inline notes go in `comments: [{ path, line, body }]`.',
    insteadOf: {
      tool: "comment_on_issue",
      discriminator: "choose this one when the DECISION must be recorded (APPROVE or REQUEST_CHANGES); a comment carries no state",
    },
    misuse:
      "an APPROVE is a claim made on the user's behalf: submit one only when you have read the diff and can name what you verified. REQUEST_CHANGES without a body is refused",
    proves:
      "a review records YOUR reading of the diff, not a passing build. Green checks do not make an approval true.",
    effects: "external",
    autonomy: "ask",
    sensitivity: "project",
  },
  update_pull_request: {
    when: "the pull request's own text no longer matches the change after a review round, or the user wants it closed or re-targeted",
    how: 'update_pull_request({ number: 17, body: "…full new description…" }) — the body REPLACES the old one, so read it first.',
    insteadOf: {
      tool: "push_changes",
      discriminator: "choose this one to change the DESCRIPTION or state of a PR; push_changes is what changes its CODE",
    },
    misuse:
      "closing is not merging: `state: \"closed\"` leaves the branch and the commits exactly as they are",
    effects: "external",
    autonomy: "ask",
    sensitivity: "project",
  },
  // ── Shipping ──────────────────────────────────────────────
  create_working_branch: {
    when: "you want the working branch named deliberately before a push (optional — push_changes creates one when needed)",
    how: 'create_working_branch({ name: "fix-login-bug" }) — a timestamped agent/ prefix is added for you.',
    effects: "external",
    autonomy: "act",
    sensitivity: "project",
  },
  push_changes: {
    when: "the change set is complete, reviewed by you with get_workspace_diff, and verified at the strongest tier available",
    how: 'push_changes({ commitMessage: "feat(scope): why", prBody: "what changed and why" }) — one commit, then a pull request.',
    misuse:
      "never push to 'see if it works'. If the user rejected the last push, adapt to their note instead of resending the same change set",
    effects: "external",
    autonomy: "ask",
    sensitivity: "project",
  },
  // ── The app's own features (no repository needed) ─────────
  search_web: {
    when: "the fact is outside this repository and you do not have its URL — a dependency's current API, a breaking change, an unfamiliar error",
    how: 'search_web({ query: "vite 8 defineConfig breaking change" }) — name the library and the version when the answer depends on it.',
    insteadOf: {
      tool: "fetch_url",
      discriminator: "choose this one to FIND the page; fetch_url reads a page whose URL you already have",
    },
    misuse: "an excerpt is a LEAD, not the document: fetch the best result before quoting it",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  fetch_url: {
    when: "you have a URL and need what it says — docs, an API reference, a changelog, a spec, an error you have not seen",
    how: 'fetch_url({ url: "https://..." }) — raise maxChars for a long reference page.',
    insteadOf: {
      tool: "search_web",
      discriminator: "choose this one to READ a page you can address; search when you only have the question",
    },
    misuse: "never invent a URL you do not know — ask the user for it instead",
    proves: "a page describes what SHOULD happen. Reading it is never verification of this codebase.",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  search_library: {
    when: "the work involves ServiceNow server-side, client-side or utility APIs and you need the real signature",
    how: 'search_library({ query: "addQuery" }) or search_library({ api: "GlideRecord" }) — no arguments lists what the reference covers.',
    misuse: "a wrong argument list in ServiceNow fails at runtime, often silently: look it up rather than recalling it",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  format_code: {
    when: "you are about to write generated or hand-edited text and it should match the project's shape, or minified JSON needs to become readable first",
    how: 'format_code({ language: "json", code }) — it RETURNS text, not a file change: applying the result is yours to do.',
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  compare_data: {
    when: "the question is what DIFFERS between two lists, two JSON documents or two config files — including reordered and missing items",
    how: "compare_data({ mode: \"json\" | \"list\" | \"env\", a, b }) — env mode compares by KEY and never reproduces a secret value.",
    insteadOf: {
      tool: "diff_text",
      discriminator: "choose this one for structure: sets, key order, .env files, JSON paths",
    },
    effects: "none",
    autonomy: "act",
    sensitivity: "personal",
  },
  diff_text: {
    when: "you want to SHOW what changed between two blocks of text — an original and a revision someone pasted",
    how: 'diff_text({ original, modified }) — language is detected when omitted.',
    insteadOf: {
      tool: "compare_data",
      discriminator: "choose this one when a visual unified diff between two texts is the answer",
    },
    effects: "none",
    autonomy: "act",
    sensitivity: "personal",
  },
  http_request: {
    when: "a request should be SENT to find out what it returns — the shape of a payload, a 404 vs a 401, a health check — including the user's own localhost and staging services",
    how: 'http_request({ method: "GET", url: "http://localhost:3000/api/health" }) — headers is an object, never a JSON string.',
    insteadOf: {
      tool: "http_write",
      discriminator: "choose this one to FETCH or inspect. Reading an endpoint never needs approval; only a change does",
    },
    misuse: "a 4xx/5xx here is the endpoint's ANSWER, not a tool failure: report it as the service's behaviour",
    proves: "what the service returns right now from this browser — a CORS block is not proof the service is down.",
    effects: "external",
    autonomy: "act",
    sensitivity: "personal",
  },
  http_write: {
    when: "the request must CHANGE something in an external service — POST, PUT, PATCH, DELETE — and the user has asked for that change",
    how: 'http_write({ method: "POST", url, body, why: "one line on what this is for" }) — the user sees it and nothing is sent until they approve.',
    insteadOf: {
      tool: "http_request",
      discriminator: "choose this one only when data must change; to read an endpoint use http_request, which needs no approval",
    },
    misuse:
      "never use this to fetch or to 'test' an endpoint, and never to publish code — repository changes ship through their own reviewed commit. If the user declines, their note is your instruction — adapt rather than resending",
    effects: "external",
    autonomy: "ask",
    sensitivity: "personal",
  },
  create_diagram: {
    when: "a picture explains it better than prose — an architecture, a request flow, a state machine, a data model — and especially when the user asks to SEE how it fits",
    how: "create_diagram({ name, nodes: [{ id, label, detail? }], edges: [{ from, to }] }) — 5 to 15 legible nodes, short stable ids.",
    insteadOf: {
      tool: "open_in_tool",
      discriminator: "choose this one to CREATE a board; open_in_tool only takes the user to a tool that already has content",
    },
    misuse:
      "after drawing, follow with open_in_tool (target drawflows, no nodes) — passing the same nodes again draws a second copy",
    effects: "user-view",
    autonomy: "undoable",
    sensitivity: "project",
  },
  open_in_tool: {
    when: "the user should SEE or continue working with something in the tool built for it — a snippet, a diff, a request, a dataset, a board",
    how: 'open_in_tool({ target: "api-tester", url, method }) — targets compiler, formatters, diff, comparators, api-tester, library, drawflows.',
    insteadOf: {
      tool: "create_diagram",
      discriminator: "choose this one to hand over EXISTING content and move the user there; it creates nothing by itself",
    },
    misuse:
      "it moves the user's screen: use it when seeing the artefact is the point, not for every answer. It also does not RUN anything — a request opened in the API Tester is not sent, a snippet in the Compiler is not executed. Say which you did",
    effects: "user-view",
    autonomy: "undoable",
    sensitivity: "project",
  },
  read_app: {
    when: "you need a fact about the user's own work in this app — which requests they have, what a comparison or diff session holds, which boards exist, what their variables are — and especially when the user refers to something they have here (\"the staging call\", \"my board\", \"that 401\")",
    how: 'read_app({ family: "api-tester" }) — families: editor, formatters, comparators, diff, api-tester, library, drawflows, settings, activity. No family lists them all.',
    insteadOf: {
      tool: "open_in_tool",
      discriminator: "choose this one to READ what the app already holds; open_in_tool puts content in front of the user and creates nothing",
    },
    misuse:
      "a credential-shaped value comes back as `•••• (N chars hidden)` on purpose — never ask the user to paste it and never invent one, reference it as `{{NAME}}` where the app substitutes variables",
    effects: "none",
    autonomy: "act",
    sensitivity: "personal",
  },
  act_app: {
    when: "the user asks you to CHANGE something in this app — fix a staging variable, tidy a comparison, rename or delete a board, set a tab's stdin, open a tab with content",
    how: 'act_app({ family: "api-tester", action: "set_var", args: { key: "API_BASE", value: "https://staging.example.com" } }) — `describe_tools({ family })` lists the actions and their argument shapes.',
    insteadOf: {
      tool: "open_in_tool",
      discriminator: "choose this one when the user's own stored work should CHANGE; open_in_tool only shows them something",
    },
    misuse:
      "read the family first — an action that names an id you never read is refused with the ids that exist. Every write is recorded in the `activity` family, so act rather than asking, and mention that it can be undone",
    effects: "app-data",
    autonomy: "undoable",
    sensitivity: "personal",
  },
  describe_tools: {
    when: "you are about to read or act on a feature family you have not used this conversation, and you need its action names or argument shapes",
    how: 'describe_tools({ family: "comparators" }) — omit the family to describe them all in one answer.',
    insteadOf: {
      tool: "read_app",
      discriminator: "choose this one to learn what a family ALLOWS; read_app returns what it currently HOLDS",
    },
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  // ── MCP servers ───────────────────────────────────────────
  list_mcp_tools: {
    when: "a task mentions a service that is not in this repository, or you are about to call one and are not sure what is exposed",
    how: "list_mcp_tools({}) — reads every connected server's tool list.",
    insteadOf: {
      tool: "call_mcp_tool",
      discriminator: "choose this one to DISCOVER: the schemas of the tools a server exposes",
    },
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  call_mcp_tool: {
    when: "the user's request clearly needs one of the tools list_mcp_tools reported",
    how: "call_mcp_tool({ server, tool, arguments }) — arguments must match the schema that server published.",
    insteadOf: {
      tool: "list_mcp_tools",
      discriminator: "choose this one to ACT on an external service after you have read its schema",
    },
    misuse:
      "these tools change real data OUTSIDE this repository: say what you changed, and never call one to explore",
    effects: "external",
    autonomy: "ask",
    sensitivity: "personal",
  },
  // ── The harness conversation ──────────────────────────────
  update_plan: {
    when: "the job takes more than two or three steps and the user should be able to watch it progress",
    how: 'update_plan({ steps: [{ text: "outcome-shaped step", status: "active" }, { text: "…" }] }) — send the WHOLE plan every time; exactly one step is "active".',
    misuse:
      "never mark a step done before the work is in the workspace; a step you cannot finish stays pending with the reason stated in one line",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  ask_user: {
    when: "the work is blocked on a decision only the user can make: two defensible approaches, an ambiguous requirement, a destructive change, or information that is not in the repository",
    how: 'ask_user({ header: "Auth strategy", question: "One sentence naming the decision.", options: [{ label: "Which one (Recommended)", description: "trade-off" }] }) — 2 to 4 options, recommended first.',
    insteadOf: {
      tool: "suggest_next",
      discriminator: "choose this one when a wrong guess costs work and you are PAUSED until they answer",
    },
    misuse:
      "do not ask what a tool could establish, do not ask twice in a turn, and do not ask when a sensible default exists — take the default, say which one you took, and continue",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
  suggest_next: {
    when: "you have just finished a chunk of work and continuing should be one click instead of a sentence the user composes",
    how: 'suggest_next({ suggestions: [{ label: "Add tests", prompt: "A self-contained instruction, not \\"do that\\"." }] }) — a close next step plus one or two that branch wider.',
    insteadOf: {
      tool: "ask_user",
      discriminator: "choose this one to OFFER next moves while your reply stands on its own; it is never a question",
    },
    misuse: "never repeat a suggestion already made in this thread, and never offer a step you would refuse to carry out",
    effects: "none",
    autonomy: "act",
    sensitivity: "public",
  },
};

/**
 * Bullets that go into the prompt for one tool.
 *
 * The prompt is GENERATED from the contract rather than written beside it, so
 * a tool cannot be documented as available while lacking a usage line — and a
 * tool that is withheld from this turn's surface cannot be advertised in prose
 * (the bug this generation exists to prevent: a free model was told about
 * `http_write` while its schema list never offered it).
 */
/**
 * Bullets that go into the prompt for one tool.
 *
 * `siblings` is the set of tool names the SAME block is describing. The
 * instead-of sentence is rendered only when the sibling is in it, and that
 * condition is the whole point: a line that says "use this over `run_command`"
 * on a turn that withheld `run_command` is the advertised-but-withheld bug in
 * miniature. Omit the set to render the line without its sibling comparison.
 */
export function bulletFor(name: ToolName, siblings?: ReadonlySet<string>): string {
  const contract = TOOL_CONTRACTS[name];
  const misuse = contract.misuse ? ` Avoid: ${contract.misuse}` : "";
  const sibling =
    contract.insteadOf && siblings?.has(contract.insteadOf.tool)
      ? ` Use this over \`${contract.insteadOf.tool}\` when: ${contract.insteadOf.discriminator}.`
      : "";
  return `- ${name}: ${contract.when}. ${contract.how}${sibling}${misuse}`;
}

/** Bullets for a set of tools, in the order given (registry order) */
export function bulletsFor(names: readonly string[]): string[] {
  const set = new Set(names);
  return names
    .filter((n): n is ToolName => n in TOOL_CONTRACTS)
    .map((n) => bulletFor(n, set));
}

/** The contract for one tool name, or undefined when it is not a tool */
export function contractFor(name: string): ToolContract | undefined {
  return name in TOOL_CONTRACTS ? TOOL_CONTRACTS[name as ToolName] : undefined;
}

/**
 * The corrective line for a failed call: what this tool is FOR, what it is not,
 * and the sibling to reach for instead.
 *
 * This is the text the turn engine attaches to the second identical failure —
 * the moment the raw schema error has already proved insufficient.
 */
export function contractHint(name: string): string | undefined {
  const contract = contractFor(name);
  if (!contract) return undefined;
  const parts = [`\`${name}\`: ${contract.how}`];
  if (contract.insteadOf) {
    const sibling = contract.insteadOf.tool;
    parts.push(`If that is not what you meant, note that ${sibling} is a different tool — ${contract.insteadOf.discriminator}.`);
  }
  if (contract.misuse) parts.push(`Common mistake: ${contract.misuse}`);
  return parts.join(" ");
}

/** Pairs a tool is mutually confused with, for the contract test */
export function confusionPairs(): Array<{ a: ToolName; b: ToolName; discriminator: string }> {
  const pairs: Array<{ a: ToolName; b: ToolName; discriminator: string }> = [];
  for (const [name, contract] of Object.entries(TOOL_CONTRACTS)) {
    if (!contract?.insteadOf) continue;
    pairs.push({ a: name as ToolName, b: contract.insteadOf.tool, discriminator: contract.insteadOf.discriminator });
  }
  return pairs;
}
