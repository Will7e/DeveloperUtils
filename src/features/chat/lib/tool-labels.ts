// ============================================================
// Tool Labels — One Name Per Tool, Shared By Every Surface
// ============================================================
// Three surfaces describe the same tool call and must not describe it
// differently: the step rows in the transcript ("Read src/app.tsx"), the live
// activity rail ("Reading src/app.tsx"), and the icon beside both. They used to
// be two switches inside ToolCallBlock.tsx, which is fine until a second caller
// needs them — then the choice is import a component to get a string, or write a
// second switch and let the two drift, where the drift shows up as one screen
// saying the agent is "running" while another says it is "executing".
//
// So the labels are a TABLE: one row per tool, naming the icon, the past tense
// the transcript reads in, the present participle a live rail needs, and the
// phase the tool puts the turn in. A row is the whole answer, so there is no
// second place for a tool's name to be written down.
//
// Partial, deliberately: a new tool with no row still works (the fallbacks are
// honest — the raw name, a neutral icon, an "working" phase), because a missing
// label should cost a nice word, never a crash or a blank row. Tools that DO
// have a row are keyed by `ToolName`, so a typo fails the build.

import {
  AlignLeft,
  ArrowLeftRight,
  BookOpen,
  Bot,
  Brain,
  CheckCheck,
  FileDiff,
  FileMinus2,
  FilePen,
  FileText,
  FilePlus2,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Globe,
  Hammer,
  Info,
  Key,
  LibraryBig,
  ListChecks,
  ListTree,
  MessageCircleQuestion,
  Play,
  Plug,
  Search,
  Send,
  Shapes,
  Sparkles,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ToolName } from "../types";

/** What the rail says the agent is doing, in one word */
export type ActivityPhase =
  | "thinking"
  | "reading"
  | "searching"
  | "editing"
  | "writing"
  | "running"
  | "verifying"
  | "delegating"
  | "waiting"
  | "idle";

export interface ToolLabel {
  icon: ComponentType<{ className?: string }>;
  /** Past tense — what a finished step row says ("Read", "Edited") */
  past: string;
  /** Present participle — what a live rail says ("Reading", "Editing") */
  active: string;
  phase: ActivityPhase;
}

type Icon = ComponentType<{ className?: string }>;

const LABELS: Partial<Record<ToolName, ToolLabel>> = {
  // ── Repository reading ──
  list_repo_files: { icon: FolderTree, past: "Listed files", active: "Listing files", phase: "reading" },
  find_files: { icon: Search, past: "Found files", active: "Finding files", phase: "searching" },
  read_file: { icon: FileText, past: "Read", active: "Reading", phase: "reading" },
  read_files: { icon: FileText, past: "Read", active: "Reading", phase: "reading" },
  search_code: { icon: Search, past: "Searched repo", active: "Searching repo", phase: "searching" },
  search_workspace: {
    icon: Search,
    past: "Searched working copy",
    active: "Searching working copy",
    phase: "searching",
  },
  get_repo_overview: {
    icon: ListTree,
    past: "Surveyed repo",
    active: "Surveying repo",
    phase: "reading",
  },
  // ── Repository writing ──
  write_file: { icon: FilePlus2, past: "Wrote", active: "Writing", phase: "writing" },
  edit_file: { icon: FilePen, past: "Edited", active: "Editing", phase: "editing" },
  delete_file: { icon: FileMinus2, past: "Deleted", active: "Deleting", phase: "editing" },
  get_workspace_diff: {
    icon: FileDiff,
    past: "Reviewed diff",
    active: "Reviewing diff",
    phase: "verifying",
  },
  create_working_branch: {
    icon: GitBranch,
    past: "Created branch",
    active: "Creating branch",
    phase: "running",
  },
  push_changes: { icon: GitPullRequest, past: "Pushed", active: "Pushing", phase: "running" },
  // ── Verification ──
  run_checks: { icon: CheckCheck, past: "Ran checks", active: "Running checks", phase: "verifying" },
  verify_with_ci: {
    icon: Hammer,
    past: "Verified with CI",
    active: "Waiting on CI",
    phase: "verifying",
  },
  // ── The turn's own machinery ──
  update_plan: { icon: ListChecks, past: "Updated plan", active: "Updating plan", phase: "thinking" },
  read_skill: { icon: BookOpen, past: "Read skill", active: "Reading skill", phase: "reading" },
  remember: { icon: Brain, past: "Remembered", active: "Remembering", phase: "writing" },
  set_env: { icon: Key, past: "Stored env vars", active: "Storing env vars", phase: "writing" },
  delegate: { icon: Bot, past: "Delegated", active: "Delegating", phase: "delegating" },
  run_tool_program: {
    icon: Play,
    past: "Ran tool program",
    active: "Running tool program",
    phase: "running",
  },
  ask_user: {
    icon: MessageCircleQuestion,
    past: "Asked you",
    active: "Waiting for you",
    phase: "waiting",
  },
  suggest_next: { icon: Sparkles, past: "Suggested next steps", active: "Suggesting next steps", phase: "writing" },
  // ── External world ──
  list_mcp_tools: { icon: Plug, past: "Listed MCP tools", active: "Listing MCP tools", phase: "reading" },
  call_mcp_tool: { icon: Plug, past: "Called MCP tool", active: "Calling MCP tool", phase: "running" },
  run_command: { icon: Play, past: "Ran", active: "Running", phase: "running" },
  search_web: { icon: Globe, past: "Searched web", active: "Searching web", phase: "searching" },
  fetch_url: { icon: Globe, past: "Fetched", active: "Fetching", phase: "reading" },
  // ── This app's own tools ──
  run_code: { icon: Play, past: "Ran code", active: "Running code", phase: "running" },
  format_code: { icon: AlignLeft, past: "Formatted", active: "Formatting", phase: "editing" },
  compare_data: { icon: ArrowLeftRight, past: "Compared", active: "Comparing", phase: "reading" },
  diff_text: { icon: FileDiff, past: "Diffed", active: "Diffing", phase: "reading" },
  search_library: {
    icon: LibraryBig,
    past: "Searched reference",
    active: "Searching reference",
    phase: "searching",
  },
  http_request: { icon: Globe, past: "Requested", active: "Requesting", phase: "reading" },
  http_write: { icon: Send, past: "Sent request", active: "Sending request", phase: "running" },
  create_diagram: { icon: Shapes, past: "Drew diagram", active: "Drawing diagram", phase: "writing" },
  open_in_tool: {
    icon: SquareArrowOutUpRight,
    past: "Opened in tool",
    active: "Opening in tool",
    phase: "running",
  },
  // ── The agent as a user of this app ──
  read_app: { icon: LibraryBig, past: "Read app state", active: "Reading app state", phase: "reading" },
  act_app: { icon: FilePen, past: "Changed app state", active: "Changing app state", phase: "writing" },
  describe_tools: {
    icon: ListChecks,
    past: "Looked up actions",
    active: "Looking up actions",
    phase: "reading",
  },
};

/** The icon for a tool, with a neutral fallback for an unlabelled one */
export function toolIcon(name: ToolName): Icon {
  return LABELS[name]?.icon ?? Info;
}

/** Past tense: what a completed step row says */
export function toolVerb(name: ToolName): string {
  return LABELS[name]?.past ?? name;
}

/** Present participle: what a live rail says while the call is in flight */
export function toolActivityVerb(name: ToolName): string {
  return LABELS[name]?.active ?? name;
}

/**
 * The phase a tool puts the turn in.
 *
 * `running` for an unlabelled tool rather than `idle`: the rail's contract is
 * "the agent is doing something", and the honest answer for an unknown tool is
 * that, not silence.
 */
export function toolPhase(name: ToolName): ActivityPhase {
  return LABELS[name]?.phase ?? "running";
}
