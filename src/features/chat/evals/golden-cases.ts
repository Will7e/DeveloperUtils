// ============================================================
// Golden Cases — The Decisions We Expect, Pinned
// ============================================================
// Two failures reached a user and had to be diagnosed by hand:
//
//   1. "fetch data from this endpoint" → the model called `http_write` on a
//      turn whose surface withheld it, with `headers` as a JSON string, and the
//      schema error named no alternative;
//   2. "use our tools" → the agent had no reach into the app's own features.
//
// Both were fixed. Nothing stopped either from coming back — and the honest
// truth about an agent harness is that most fixes are made of PROMPT TEXT,
// SURFACE FILTERING and ARGUMENT COERCION, all three of which are easy to undo
// by accident while "improving" something else.
//
// So this file is the memory. Each case names a real request, the tool that
// should win it, the sibling it gets confused with, and — where the case came
// from a transcript — the recorded call and error, which the case REPLAYS
// through the same door the turn engine uses (`validateToolCall`, which
// includes coercion; `withheldRefusal`, which is the surface refusal). A case
// passes only if:
//
//   • the expected tool is actually offered on that turn's surface;
//   • the composed prompt carries a usage bullet for it; and
//   • the sibling is either documented as the worse choice in that bullet, or
//     refused with a pointer naming the expected tool.
//
// What this file is NOT: a test of model behaviour. Running a model in CI is
// neither free nor deterministic, so these cases pin the HARNESS half of the
// decision — the half we control and the half that broke. A case that carries
// `recorded` is the model half, frozen: the exact call and the exact error, so
// the mechanism that turns it into a correct next move is under test.

import type { ChatConversation, ChatMode, ModelInfo, RepoContext, ToolName } from "../types";
import { resolveToolSurface } from "../lib/tool-profiles";
import { withContractHint, withheldRefusal } from "../lib/tool-surface";
import { validateToolCall } from "../lib/tool-registry";
import { composeAppToolsPrompt, composeRepoPrompt } from "../services/turn-prep";
import { classifyConversation } from "../lib/failure-taxonomy";

/** The same shape lib/failure-taxonomy.ts recognises in a stored transcript */
const ARGUMENT_ERROR_RE = /Argument \\?"[^"\\]{1,80}\\?" (?:must|has|exceeds|is not|is required)/;

/** A tool call as the model emitted it, with the error the user saw */
export interface RecordedFailure {
  called: ToolName;
  /** Raw arguments string, exactly as emitted (the escaping matters) */
  arguments: string;
  /** The failure text that reached the transcript */
  error: string;
}

export interface GoldenCase {
  id: string;
  /** Why this case exists, in one line a reviewer can check */
  why: string;
  /** The user's request, verbatim where it came from a real transcript */
  prompt: string;
  /** Which capability profile the turn used */
  profile: "lean" | "full";
  /** Whether a repository was attached */
  repoAttached: boolean;
  /** Operating mode (defaults to build) */
  mode?: ChatMode;
  /** The tool that should win this request (null = prose is the right answer) */
  expect: ToolName | null;
  /** The sibling it gets mistaken for */
  forbid?: ToolName[];
  /** The call that actually failed, when the case came from a transcript */
  recorded?: RecordedFailure;
}

/** A model that gets the lean surface (free or small) and one that does not */
const MODEL: Record<GoldenCase["profile"], ModelInfo> = {
  lean: { id: "free", name: "Free", contextLength: 131_000, isFree: true },
  full: { id: "big", name: "Big", contextLength: 200_000, isFree: false },
};

const REPO: RepoContext = { owner: "acme", repo: "web", branch: "main", attachedAt: 0 };

/** The surface a case's turn sends */
export function caseSurface(c: GoldenCase): string[] {
  return resolveToolSurface(c.mode ?? "build", MODEL[c.profile], {
    repoAttached: c.repoAttached,
  }).tools.map((t) => t.function.name);
}

/** The prompt a case's turn composes, for both blocks */
export function casePrompt(c: GoldenCase): string {
  const surface = caseSurface(c);
  const blocks = [c.repoAttached ? composeRepoPrompt(REPO, surface) : "", composeAppToolsPrompt(surface)];
  return blocks.filter(Boolean).join("\n\n");
}

/** True when the case's turn would refuse the recorded call on its SURFACE */
function ledBySurfaceRefusal(c: GoldenCase, offered: ReadonlySet<string>): boolean {
  return Boolean(c.recorded && !offered.has(c.recorded.called) && withheldRefusal(c.recorded.called, offered));
}

export interface CaseResult {
  id: string;
  ok: boolean;
  failures: string[];
}

/**
 * Checks one case against the live harness.
 *
 * Returns every failure rather than the first: a case usually breaks in more
 * than one place at once (a tool dropped from a profile AND its bullet lost),
 * and fixing them one run at a time is how a suite becomes a chore.
 */
export function checkCase(c: GoldenCase): CaseResult {
  const failures: string[] = [];
  const offered = new Set(caseSurface(c));
  const prompt = casePrompt(c);

  if (c.expect) {
    if (!offered.has(c.expect)) {
      failures.push(`\`${c.expect}\` is NOT on the ${c.profile}/${c.mode ?? "build"} surface — it cannot be chosen`);
    }
    const bullet = prompt.split("\n").find((line) => line.startsWith(`- ${c.expect}:`));
    if (!bullet) {
      failures.push(`the prompt has no usage bullet for \`${c.expect}\``);
    }
    for (const sibling of c.forbid ?? []) {
      if (offered.has(sibling)) {
        // Both are callable, so the discriminator has to be in the bullet the
        // model reads — otherwise it is choosing between two undocumented tools.
        if (bullet && !bullet.includes(sibling)) {
          failures.push(
            `\`${sibling}\` is offered too, but \`${c.expect}\`'s bullet never distinguishes itself from it`
          );
        }
      } else {
        // The sibling is withheld, so the REFUSAL is what has to be useful:
        // either it points at the tool that should have been used, or it shows
        // the surface the model was actually given. A refusal that only says no
        // is what made the user type "use our tools".
        const refusal = withheldRefusal(sibling, offered);
        if (!refusal) {
          failures.push(`\`${sibling}\` is withheld but has no refusal message at all`);
        } else if (!refusal.includes(c.expect) && !/What you can call this turn/.test(refusal)) {
          failures.push(
            `\`${sibling}\` is withheld and its refusal names neither \`${c.expect}\` nor the offered surface`
          );
        }
      }
    }
  }

  if (c.recorded) {
    const validation = validateToolCall(c.recorded.called, c.recorded.arguments);
    const wasArgumentError = ARGUMENT_ERROR_RE.test(c.recorded.error);
    // Two ways the recorded failure is gone, and which one applies depends on
    // whether the tool was offered at all:
    //
    //   • offered → the call must now VALIDATE: coercion parsed the stringified
    //     nested value, which is the repair the case is about.
    //   • withheld → the call is refused for a different, correct reason (the
    //     tool does not do this), and the recorded text can no longer appear.
    //     For the reported repro that means `http_write` answers "method must be
    //     one of POST/PUT/PATCH/DELETE" instead of a bare argument failure — the
    //     right answer, reached for the right reason.
    if (wasArgumentError) {
      const reproducible = !validation.ok && validation.error === c.recorded.error;
      if (reproducible) {
        failures.push(
          `the recorded argument failure still happens verbatim: \`${c.recorded.called}\` → ${c.recorded.error}`
        );
      }
      if (
        !validation.ok &&
        !validation.error &&
        !ledBySurfaceRefusal(c, offered)
      ) {
        failures.push(`\`${c.recorded.called}\` gave neither a repair nor a reason for the rejection`);
      }
    }
    // And the exact text the user saw must be gone — either the call now
    // validates, or the result carries the contract hint instead of a bare error.
    const hintOf = (): string => {
      const result = withContractHint({
        callId: "c",
        name: c.recorded!.called,
        ok: false,
        data: { error: c.recorded!.error },
        durationMs: 1,
      });
      return typeof (result.data as { hint?: unknown })?.hint === "string"
        ? (result.data as { hint: string }).hint
        : "";
    };
    if (!validation.ok && hintOf() === "") {
      failures.push(`the repeat of \`${c.recorded.called}\` still comes back with no contract hint`);
    }
    // The recorded tool being out of reach for a lean turn is the mechanism the
    // user's transcript needed: the refusal has to point at the right sibling.
    if (!offered.has(c.recorded.called) && c.expect) {
      const refusal = withheldRefusal(c.recorded.called, offered);
      if (!refusal || !refusal.includes(c.expect)) {
        failures.push(
          `\`${c.recorded.called}\` is withheld but its refusal does not name \`${c.expect}\``
        );
      }
    }
  }

  if (!c.expect && c.recorded) {
    failures.push("a recorded failure with no expected tool cannot be checked");
  }

  return { id: c.id, ok: failures.length === 0, failures };
}

/** Every case, checked. The test asserts this list is all-green. */
export function runGoldenCases(cases: readonly GoldenCase[] = GOLDEN_CASES): CaseResult[] {
  return cases.map(checkCase);
}

/** A readable report for a failing run */
export function formatCaseResults(results: readonly CaseResult[]): string {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return `${results.length} golden case(s) hold.`;
  return failed
    .map((r) => [r.id, ...r.failures.map((f) => `  ✗ ${f}`)].join("\n"))
    .join("\n\n");
}

// ── The cases ────────────────────────────────────────────────

/** The turn's lean surface, as the free model in the transcript received it */
const LEAN_SURFACE: ToolName[] = [
  "list_repo_files",
  "find_files",
  "read_file",
  "read_files",
  "search_web",
  "fetch_url",
  "search_workspace",
  "search_code",
  "get_repo_overview",
  "read_skill",
  "write_file",
  "edit_file",
  "get_workspace_diff",
  "push_changes",
  "ask_user",
  "suggest_next",
  "run_code",
  "format_code",
  "compare_data",
  "diff_text",
  "search_library",
  "http_request",
  "create_diagram",
  "open_in_tool",
  "read_app",
  "act_app",
  "describe_tools",
];

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    id: "endpoint-read",
    why: "the reported transcript: http_write was called for a GET, on a surface that withheld it, with headers as a JSON string",
    prompt: "fetch data from this endpoint",
    profile: "lean",
    repoAttached: true,
    expect: "http_request",
    forbid: ["http_write"],
    recorded: {
      called: "http_write",
      arguments: JSON.stringify({
        method: "GET",
        url: "https://api.example.com/orders",
        headers: '{"Accept":"application/json"}',
      }),
      error: 'Argument "headers" must be of type object, got string.',
    },
  },
  {
    id: "endpoint-write",
    why: "the same request shape, but for a change — the write tool is the right one and must be reachable",
    prompt: "create a ticket for this on the issue tracker endpoint",
    profile: "full",
    repoAttached: true,
    expect: "http_write",
    forbid: ["http_request"],
  },
  {
    id: "search-code-i-just-wrote",
    why: "search_code reads GitHub's index, which lags a turn's own edits — search_workspace reads the working copy",
    prompt: "where is parseToolArguments used? I just added it",
    profile: "full",
    repoAttached: true,
    expect: "search_workspace",
    forbid: ["search_code"],
  },
  {
    id: "file-by-name",
    why: "\"the vite config\" names a file whose path the agent does not know — a name match, not a content search",
    prompt: "open the vite config and check the alias block",
    profile: "full",
    repoAttached: true,
    expect: "find_files",
    forbid: ["search_workspace"],
  },
  {
    id: "several-known-paths",
    why: "three known paths are one batched call, not three rounds",
    prompt: "read src/a.ts, src/b.ts and src/c.ts and tell me which one exports runTurn",
    profile: "lean",
    repoAttached: true,
    expect: "read_files",
    forbid: ["read_file"],
  },
  {
    id: "window-a-known-file",
    why: "the path is known, so the file read wins over a content search",
    prompt: "what does the catch block in src/features/chat/lib/tools.ts do?",
    profile: "full",
    repoAttached: true,
    expect: "read_file",
    forbid: ["search_workspace"],
  },
  {
    id: "look-up-a-fact",
    why: "no URL yet — the search finds the page rather than fetch_url guessing one",
    prompt: "what is the current React 19 API for useActionState?",
    profile: "full",
    repoAttached: false,
    expect: "search_web",
    forbid: ["fetch_url"],
  },
  {
    id: "read-a-known-page",
    why: "the URL is in hand, so the page read wins over a search",
    prompt: "read https://react.dev/reference/react/useActionState and summarise the signature",
    profile: "full",
    repoAttached: false,
    expect: "fetch_url",
    forbid: ["search_web"],
  },
  {
    id: "check-a-snippet",
    why: "a snippet's behaviour is checked in the sandbox, not proven against the project",
    prompt: "does this regex match a Windows path?",
    profile: "full",
    repoAttached: true,
    expect: "run_code",
    forbid: ["run_command"],
  },
  {
    id: "review-my-own-change-set",
    why: "the change set lives in the workspace; diff_text only compares two strings it was handed",
    prompt: "is my change ready to push?",
    profile: "full",
    repoAttached: true,
    expect: "get_workspace_diff",
    forbid: ["diff_text"],
  },
  {
    id: "read-the-app",
    why: "the user referred to work held in this app, so the family read beats handing them a payload",
    prompt: "why did my staging request 401 last week?",
    profile: "lean",
    repoAttached: false,
    expect: "read_app",
    forbid: ["open_in_tool"],
  },
  {
    id: "change-the-app",
    why: "the user asked for a change to their own stored work, so the action tool is the tool",
    prompt: "point my staging environment at the new URL",
    profile: "lean",
    repoAttached: false,
    expect: "act_app",
    forbid: ["open_in_tool"],
  },
  {
    id: "learn-the-app-actions",
    why: "argument shapes are loaded on demand rather than shipped in every request",
    prompt: "what can you do to my comparison sessions?",
    profile: "lean",
    repoAttached: false,
    expect: "describe_tools",
    forbid: ["read_app"],
  },
  {
    id: "discover-mcp-tools",
    why: "an unfamiliar service is discovered before it is called",
    prompt: "what tools does my sentry MCP server expose?",
    profile: "full",
    repoAttached: true,
    expect: "list_mcp_tools",
    forbid: ["call_mcp_tool"],
  },
  {
    id: "draw-a-diagram",
    why:
      "the reported transcript: a free model told to draw reached for `act_app`'s drawflows family — whose only write action makes an EMPTY board — and invented `add_node`, because `create_diagram` had been withheld from the lean surface. The diagram pair is now ON that surface, and this pins it there",
    prompt: "draw a diagram of our request flow",
    profile: "lean",
    repoAttached: true,
    expect: "create_diagram",
    forbid: ["open_in_tool"],
    recorded: {
      called: "act_app",
      arguments: JSON.stringify({
        family: "drawflows",
        action: "add_node",
        args: { nodes: [{ id: "client", label: "Client" }] },
      }),
      error:
        'Family "drawflows" has no action called "add_node". Its actions: create_board, rename_board, duplicate_board, set_active_board, delete_board.',
    },
  },
  {
    id: "plan-mode-proposes",
    why: "plan mode is propose-only: the plan tool is offered and the write tools are not",
    prompt: "plan the migration to the new config loader",
    profile: "full",
    repoAttached: true,
    mode: "plan",
    expect: "update_plan",
    forbid: ["write_file", "edit_file"],
  },
  // ── The conversation around the code ──────────────────────
  // Before these existed, every one of these requests ended the same way: the
  // agent could push a pull request and had no endpoint to read one back, so
  // the honest answer was "paste the review here". Each case pins one half of
  // that loop, and each names the sibling that looks close enough to win by
  // accident.
  {
    id: "what-the-reviewer-asked-for",
    why: "the review lives on GitHub; the workspace diff shows only unpushed edits, so answering from it would describe the wrong thing entirely",
    prompt: "the reviewer left feedback on my open PR — fix what they asked for",
    profile: "full",
    repoAttached: true,
    expect: "read_pull_request",
    forbid: ["get_workspace_diff"],
  },
  {
    id: "why-ci-is-red",
    why: "a red branch is a LOG read, not a dispatch: verify_with_ci starts its own run and would report on a revision that is not the failed one",
    prompt: "CI is red on my branch — what broke?",
    profile: "full",
    repoAttached: true,
    expect: "read_ci_logs",
    forbid: ["verify_with_ci"],
  },
  {
    id: "find-my-open-pr",
    why: "the branch is known and the NUMBER is not: the list answers by head branch, and reading a pull request needs a number already",
    prompt: "which pull request is the branch you just pushed on?",
    profile: "full",
    repoAttached: true,
    expect: "list_pull_requests",
    forbid: ["read_pull_request"],
  },
  {
    id: "reply-on-the-thread",
    why: "a reply carries no state; only a review can block a merge, so reaching for one to say 'fixed' would record a verdict nobody asked for",
    prompt: "reply on the issue that it's fixed in the new push",
    profile: "full",
    repoAttached: true,
    expect: "comment_on_issue",
    forbid: ["review_pull_request"],
  },
  {
    id: "answer-an-inline-note",
    why: "a reviewer's note on a line is a thread of its own: answering it in the general conversation is how the reply is never read, which is why the read exposes the comment id and the write accepts it",
    prompt: "answer the reviewer's comment on line 42 explaining that the branch is now tested",
    profile: "full",
    repoAttached: true,
    expect: "comment_on_issue",
    // No forbidden sibling: the competitor here is doing nothing (or replying in
    // the wrong place), and `read_pull_request` is the step BEFORE this one, not
    // a rival to it.
  },
  {
    id: "lean-reads-the-review",
    why: "a free model asked to fix review feedback must be able to READ the review: without this tool its only moves were guessing or asking the user to paste one in",
    prompt: "the reviewer left notes on my PR — fix what they asked for",
    profile: "lean",
    repoAttached: true,
    expect: "read_pull_request",
    forbid: ["get_workspace_diff"],
  },
  {
    id: "file-a-defect-i-found",
    why: "a defect outside the task is tracked on GitHub, and filing is public — the write is offered, and the gate is what makes it the user's decision",
    prompt: "file an issue for that flaky test you just found",
    profile: "full",
    repoAttached: true,
    expect: "create_issue",
  },
];

// ── Drafting the next case from a real transcript ─────────────

export interface CaseDraft {
  /** Stable-looking id derived from the failure, for a human to keep or rename */
  id: string;
  why: string;
  prompt: string;
  recorded?: RecordedFailure;
  /** Fields a person must fill in from the turn log / the report */
  needs: string[];
}

/**
 * Turns a stored transcript's first classified failure into a case SKELETON.
 *
 * Deliberately a draft rather than a finished case: the two fields that make a
 * case meaningful — the surface the turn actually offered, and the expected
 * tool — cannot be recovered from the transcript, and inventing them would
 * produce a test that passes for the wrong reason. Everything recoverable IS
 * recovered: the request, the failing call, the error, and the fix the taxonomy
 * names.
 */
export function draftCaseFromConversation(conversation: ChatConversation): CaseDraft | null {
  const findings = classifyConversation(conversation);
  const relevant = findings.find((f) =>
    ["withheld-tool", "schema-failure", "wrong-sibling", "unknown-tool", "repeated-call"].includes(f.kind)
  );
  if (!relevant) return null;

  const firstUser = conversation.messages.find(
    (m) => m.role === "user" && !m.toolCalls && !m.toolResult && !m.hidden && m.content.trim()
  );
  const failedCall = conversation.messages
    .flatMap((m) => m.toolCalls?.calls ?? [])
    .find((c) => c.name === relevant.evidence[0]);
  const errorText =
    conversation.messages.find(
      (m) => m.toolResult && m.toolResult.ok === false && m.toolResult.name === relevant.evidence[0]
    )?.toolResult?.content ?? relevant.evidence[1] ?? "";

  return {
    id: `${relevant.kind}:${relevant.evidence[0] ?? "unknown"}`,
    why: `${relevant.detail} — fix: ${relevant.kind}`,
    prompt: firstUser?.content?.slice(0, 400) ?? "",
    recorded: failedCall
      ? {
          called: failedCall.name,
          arguments: failedCall.arguments,
          error: errorText.slice(0, 400),
        }
      : undefined,
    needs: [
      "the surface that turn offered (from the turn log): profile and repoAttached",
      "the tool that should have won (expect), and the sibling it lost to (forbid)",
    ],
  };
}

/** Facts about the suite, for a README or a report without reading the cases */
export function goldenCaseSummary(): { total: number; recorded: number; tools: string[] } {
  const tools = new Set<string>();
  for (const c of GOLDEN_CASES) {
    if (c.expect) tools.add(c.expect);
    for (const f of c.forbid ?? []) tools.add(f);
  }
  return {
    total: GOLDEN_CASES.length,
    recorded: GOLDEN_CASES.filter((c) => c.recorded).length,
    tools: [...tools].sort(),
  };
}

/**
 * The lean surface as it stood when the reported transcript happened.
 *
 * Kept as a literal so a test can assert the PROFILE still produces exactly
 * this: a tool quietly added to or removed from the lean profile changes what a
 * free model can do, and that is a product decision nobody should make by
 * accident while editing a list.
 */
export const LEAN_SURFACE_AT_THE_TIME: readonly ToolName[] = LEAN_SURFACE;

/**
 * The lean surface TODAY, as an explicit decision.
 *
 * `LEAN_SURFACE_AT_THE_TIME` is a RECORD — what the free model in the reported
 * transcript actually received — and rewriting it would destroy the evidence
 * the case is built on. So a change to the profile is stated here instead, and
 * the test holds both ends: every capability from the report is still present,
 * and the set is exactly this list rather than whatever the profile drifted to.
 * The GitHub reads were added because "fix what the reviewer asked for" is
 * unanswerable without them: the alternative for a weak model was to guess or
 * to ask the user to paste the review in.
 */
export const LEAN_SURFACE_TODAY: readonly ToolName[] = [
  ...LEAN_SURFACE,
  "read_issue",
  "read_pull_request",
  "read_ci_logs",
];
