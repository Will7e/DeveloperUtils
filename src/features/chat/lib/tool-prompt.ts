// ============================================================
// Tool Prompt — The Tool Documentation Is Generated, Not Written
// ============================================================
// The prompt used to describe tools by hand, in three arrays inside
// services/turn-prep.ts, while the tools themselves lived in the registry and
// their decisions lived nowhere. Two failures followed from that:
//
//   1. coverage drift — a tool added to the registry and forgotten in the
//      prose is a capability the model is never told about, so it never calls
//      it; and
//   2. SURFACE drift — the app block named all fourteen app tools on every
//      turn, including the three the lean profile withholds from the schema
//      list. A free model was literally told about `http_write`, was not
//      offered it, called it anyway, and the engine ran it.
//
// So the lines come from lib/tool-contracts.ts, and this module decides which
// ones ride which block — given the surface that is ACTUALLY being sent. A
// call that passes a surface cannot advertise a tool outside it.
//
// The groups exist because grouping is how a model reads a tool list: what it
// can look at, what changes, and what proves the change. They are literal name
// lists, and a test asserts every repository tool appears in exactly one of
// them, so a new tool cannot silently miss the prompt.

import type { ToolName } from "../types";
import { TOOL_REGISTRY, isRepoFreeTool } from "./tool-registry";
import { bulletFor } from "./tool-contracts";

/** Repository tools that only READ (and the read-batching program) */
export const REPO_READ_GROUP: readonly ToolName[] = [
  "get_repo_overview",
  "list_repo_files",
  "find_files",
  "read_file",
  "read_files",
  "search_code",
  "search_workspace",
  "read_process",
  "run_tool_program",
  "delegate",
];

/** Repository tools that CHANGE the working copy */
export const REPO_CHANGE_GROUP: readonly ToolName[] = [
  "edit_file",
  "write_file",
  "delete_file",
  "remember",
  "get_workspace_diff",
  "update_plan",
];

/** Repository tools that PROVE or SHIP the change */
export const REPO_VERIFY_GROUP: readonly ToolName[] = [
  "run_checks",
  "run_command",
  "run_process",
  "stop_process",
  "preview_interact",
  "preview_evaluate",
  "verify_with_ci",
  "create_working_branch",
  "push_changes",
];

/**
 * The conversation around the code, on GitHub.
 *
 * A block of its own rather than more entries in "reading and exploring",
 * because the boundary matters to a model that has just been told its edits
 * never touch GitHub: these tools DO act on GitHub — four of them write to it
 * — and the grouping is where that becomes visible. The reads sit with the
 * reads and the writes with the writes inside the group.
 */
export const REPO_COLLAB_GROUP: readonly ToolName[] = [
  "list_issues",
  "read_issue",
  "list_pull_requests",
  "read_pull_request",
  "read_ci_logs",
  "create_issue",
  "comment_on_issue",
  "review_pull_request",
  "update_pull_request",
];

/** The user's connected MCP servers (external services) */
export const REPO_MCP_GROUP: readonly ToolName[] = ["list_mcp_tools", "call_mcp_tool"];

const REPO_GROUPS: ReadonlyArray<{ title: string; tools: readonly ToolName[] }> = [
  { title: "Reading and exploring:", tools: REPO_READ_GROUP },
  { title: "Changing your working copy (never GitHub directly):", tools: REPO_CHANGE_GROUP },
  { title: "Verifying and shipping:", tools: REPO_VERIFY_GROUP },
  { title: "Reading GitHub itself — issues, pull requests, reviews, CI logs:", tools: REPO_COLLAB_GROUP },
  { title: "The user's connected MCP servers:", tools: REPO_MCP_GROUP },
];

/**
 * Every tool that needs an attached repository — DERIVED from the registry's
 * own predicate, so the repo block can never fall behind the tool set.
 */
export const REPO_PROMPT_TOOLS: readonly ToolName[] = TOOL_REGISTRY.filter(
  (t) => !isRepoFreeTool(t.name)
).map((t) => t.name);

/**
 * Every tool that works with no repository attached: the app's own features,
 * the web pair, the skill loader and the two harness-interaction tools.
 * Derived from the registry for the same reason.
 */
export const APP_PROMPT_TOOLS: readonly ToolName[] = TOOL_REGISTRY.filter((t) =>
  isRepoFreeTool(t.name)
).map((t) => t.name);

/** True when this tool is in the block's own set AND on the offered surface */
function offered(name: ToolName, surface: ReadonlySet<string> | null): boolean {
  return surface === null || surface.has(name);
}

/**
 * Bullets for the tools of one block that are on the offered surface.
 *
 * The same offered set is handed to `bulletFor` as the SIBLING set, so a
 * line can only compare itself against a tool the model can actually call this
 * turn.
 */
function bullets(names: readonly ToolName[], surface: ReadonlySet<string> | null): string[] {
  const shown = names.filter((n) => offered(n, surface));
  const siblings = surface ?? new Set<string>(shown);
  return shown.map((n) => bulletFor(n, siblings));
}

/**
 * The repository tool block.
 *
 * `surface` is the set of tool names this turn's request actually carried. When
 * it is provided, a tool outside it is not described — that is the fix for the
 * advertised-but-withheld bug — and when it is omitted (tests, callers that
 * want the full reference) every repository tool is documented.
 */
export function repoPromptLines(surface?: readonly string[]): string[] {
  const set = surface ? new Set(surface) : null;
  const lines: string[] = [];
  for (const group of REPO_GROUPS) {
    const groupBullets = bullets(group.tools, set);
    if (groupBullets.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(group.title);
    lines.push(...groupBullets);
  }
  return lines;
}

/** The repo-free (app) tool block — same surface rule */
export function appPromptLines(surface?: readonly string[]): string[] {
  const set = surface ? new Set(surface) : null;
  return bullets(APP_PROMPT_TOOLS, set);
}

/**
 * Tools in the registry that no prompt block claims.
 *
 * Used by the contract test: a tool in here is reachable by the model only if
 * it guesses, which is the same as not shipping it.
 */
export function undocumentedTools(): string[] {
  const claimed = new Set<string>([...REPO_PROMPT_TOOLS, ...APP_PROMPT_TOOLS]);
  return TOOL_REGISTRY.map((t) => t.name).filter((n) => !claimed.has(n));
}
