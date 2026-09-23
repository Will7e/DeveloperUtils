// ============================================================
// Tool Profiles — Match the Tool Surface to the Model
// ============================================================
// Fifteen tools is the right surface for a frontier model and the wrong
// one for a 7B free model. A weak model handed a large schema does three
// specific things: it calls the tool it saw last, it flattens nested
// arguments, and it burns the turn deciding. The harness cannot make the
// model better, but it can stop asking it to do something it cannot.
//
// The profile is chosen from what the CATALOG actually reports —
// context length and price — not from a vendor guess. That is deliberate:
// a hand-written "Claude likes X, GPT likes Y" table rots the moment a
// model is released, while "a 32k free model gets the lean surface"
// stays true. Hints are capability statements, never vendor folklore.
//
// Two consequences worth naming:
//   • the lean profile withholds `run_tool_program` (nested array args)
//     and `delegate` (a nested agent) — structure the model must build
//     itself, which is exactly what small models get wrong;
//   • plan mode still intersects first, so a profile can never
//     resurrect a mutating tool.

import type { ChatMode, ModelInfo, ToolDefinition } from "../types";
import { AGENT_TOOLS, PLAN_MODE_TOOLS, isRepoFreeTool } from "./tool-registry";

export type ToolProfileId = "full" | "lean";

/**
 * The lean surface: the loop a smaller model can actually complete.
 * Every entry is load-bearing — discovery, reading, one way to change a
 * file, one way to see what changed, and one way to ship.
 */
/**
 * Listed in REGISTRY order on purpose: the wire order is the registry's,
 * and re-ordering here would silently disagree with the schema the model
 * receives. Behavioural nudges ("prefer edit_file") belong in the profile
 * note, where they cost nothing and cannot contradict the wire.
 */
export const LEAN_TOOL_NAMES: readonly string[] = [
  "list_repo_files",
  "read_file",
  // A weak model is the one most likely to answer about a dependency from
  // memory, and these are reading tools with one flat argument each — the
  // same shape as read_file, so they add no loop the profile has to teach.
  // search_web matters even more here: given only fetch_url, a model that
  // does not know the URL will invent one.
  "search_web",
  "fetch_url",
  "search_workspace",
  "search_code",
  "get_repo_overview",
  // Deliberately included: a weak model is the one that most needs the
  // task-shaped discipline in a skill body, and loading one is a single
  // flat argument — the simplest call it can make.
  "read_skill",
  "write_file",
  "edit_file",
  "get_workspace_diff",
  "push_changes",
  // Asking is the cheapest good move a weak model can make, and the one it
  // is least likely to attempt: it guesses, or it narrates the uncertainty.
  // One flat schema, and the payoff is avoiding several wrong edits.
  "ask_user",
  "suggest_next",
  // ── App tools ──
  // Listed in REGISTRY order, like everything else here (the app block sits
  // after the write tools in the registry). A weak model is the one that
  // most needs a computation CHECKED rather than guessed at, and these are
  // the flattest calls in the whole surface: a language and a snippet, a
  // language and some text, one query. They also work in a chat with no
  // repository, which is where a model that cannot call anything would
  // otherwise fall back to recall.
  //
  // `http_write` and `create_diagram` are deliberately NOT here: one asks
  // the user to approve an external write, the other builds a nested
  // node/edge structure — exactly the two shapes a small model gets wrong.
  "run_code",
  "format_code",
  "compare_data",
  "diff_text",
  "search_library",
  "http_request",
];

/** Below this context length a model gets the lean surface */
const LEAN_CONTEXT_LENGTH = 64_000;

export interface ToolProfile {
  id: ToolProfileId;
  /** Wire definitions, in registry order (models attend to schema order) */
  tools: ToolDefinition[];
  /** Capability note appended to the system prompt ("" for full) */
  note: string;
}

/**
 * Prompt notes per profile. Kept short: a weak model's instruction budget
 * is the scarcest resource it has, and a wall of tool advice makes the
 * three rules that matter get lost among ten that do not.
 */
export const TOOL_PROFILE_NOTES: Record<ToolProfileId, string> = {
  full: "",
  lean: [
    "# Working within your tool budget",
    "",
    "Keep the loop small and literal:",
    "- One tool call at a time, with the arguments the schema asks for.",
    "- Read narrow windows (read_file with startLine/endLine) rather than whole large files.",
    "- To change an existing file, use edit_file with the exact text you read. write_file replaces the WHOLE file and deletes anything you did not reproduce.",
    "- Do not build tool programs or hand work to a helper agent — those tools are not available to you.",
    "- If a call fails, read the error and change the arguments. Repeating the same call will be refused.",
  ].join("\n"),
};

/**
 * Note for a repo-free turn.
 *
 * The full profile's note is empty anyway; the lean one needs a variant
 * because its existing text tells the model how to change a FILE, and a
 * conversation with no repository attached has no files to change — advice
 * about tools it does not have is exactly the instruction-budget waste this
 * profile exists to avoid.
 */
export const REPO_FREE_PROFILE_NOTES: Record<ToolProfileId, string> = {
  full: "",
  lean: [
    "# Working within your tool budget",
    "",
    "Keep the loop small and literal:",
    "- One tool call at a time, with the arguments the schema asks for.",
    "- No repository is attached, so there are no project files to read or edit. The tools you have run and check things: run_code executes a snippet, format_code tidies text, compare_data and diff_text compare two inputs, search_library reads the ServiceNow reference, and fetch_url/search_web read the public web.",
    "- Prefer running a snippet to reasoning about what it prints.",
    "- If a call fails, read the error and change the arguments. Repeating the same call will be refused.",
  ].join("\n"),
};

/** True when the catalog's own data says this model needs a smaller surface */
export function needsLeanProfile(info: ModelInfo | undefined): boolean {
  if (!info) return false; // unknown metadata is not evidence of weakness
  const window = info.contextLength ?? 0;
  if (window > 0 && window < LEAN_CONTEXT_LENGTH) return true;
  return info.isFree === true;
}

/** Registry tools allowed by a profile */
function namesForProfile(id: ToolProfileId): readonly string[] | null {
  return id === "lean" ? LEAN_TOOL_NAMES : null; // null = every tool
}

/**
 * Resolves the tool surface for one turn: capability profile first, then
 * mode. Order matters — narrowing to plan-safe LAST means a profile can
 * never introduce a mutating tool into a plan turn.
 */
export function resolveToolProfile(
  mode: ChatMode,
  info: ModelInfo | undefined,
  allTools: ToolDefinition[] = AGENT_TOOLS,
  planTools: ToolDefinition[] = PLAN_MODE_TOOLS
): ToolProfile {
  const id: ToolProfileId = needsLeanProfile(info) ? "lean" : "full";
  const allowed = namesForProfile(id);

  if (mode === "plan") {
    return {
      id,
      tools: allowed ? planTools.filter((t) => allowed.includes(t.function.name)) : planTools,
      note: TOOL_PROFILE_NOTES[id],
    };
  }
  return {
    id,
    tools: allowed ? allTools.filter((t) => allowed.includes(t.function.name)) : allTools,
    note: TOOL_PROFILE_NOTES[id],
  };
}

/**
 * The tool surface for one turn, given whether a repository is attached.
 *
 * This is the rule the whole app-tools change turns on, in one place:
 *
 *   • attached  → the profile's surface as before, which now also contains
 *                 the app tools (they are registry entries like any other);
 *   • detached  → THE APP TOOLS ONLY.
 *
 * Why detached is not "no tools": the repository tools are all reads and
 * writes of a checkout, so without one they are unusable rather than
 * optional — `read_file` with no repo has nothing to read. The app tools
 * are the opposite: the code runner, the formatter, the comparators and the
 * reference need nothing but their arguments. Withholding them because no
 * GitHub repository is connected was the single largest capability the
 * agent was missing in its most common configuration.
 *
 * Filtering happens AFTER the profile and the mode narrowing, so a lean
 * model gets the lean app subset and Plan mode still loses `http_write`.
 */
export function resolveToolSurface(
  mode: ChatMode,
  info: ModelInfo | undefined,
  options: { repoAttached: boolean }
): ToolProfile {
  const base = resolveToolProfile(mode, info);
  if (options.repoAttached) return base;
  return {
    ...base,
    tools: base.tools.filter((t) => isRepoFreeTool(t.function.name)),
    note: REPO_FREE_PROFILE_NOTES[base.id],
  };
}
