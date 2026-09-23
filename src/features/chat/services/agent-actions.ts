// ============================================================
// Agent Actions — Executor Bridge for Write/Ship Tools
// ============================================================
// tools.ts stays UI-free and store-free for the read tools; this
// module owns the coding-agent tools that need the chat store
// (workspace, gate) and the GitHub write client. chat-runner.ts
// routes write/ship calls here.

import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import { diffFile, summarizeChanges } from "../workspace/diff";
import {
  collectChanges,
  deleteFile,
  flushWorkspaceSave,
  readFile,
  revertAll,
  revertFile,
  writeFile,
  type PushFile,
} from "../workspace/workspace";
import { describeExclusions, partitionPushChanges } from "../workspace/push-selection";
import {
  proofSection,
  recordVerification,
  verificationEvidence,
  verificationLines,
  verificationWarnings,
} from "../lib/verification-ledger";
import type { PushWarning, StepChange, ToolCallResult, WorkspaceState } from "../types";
import { applyStringEdit } from "../workspace/edit";
import {
  SEARCH_MAX_FETCH_FILES,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_RESULTS,
  pickSearchCandidates,
  searchContent,
  type SearchMode,
  type WorkspaceSearchMatch,
} from "../workspace/search";
import { undoLast } from "../workspace/undo";
import { clearToolCache } from "../lib/tool-cache";
import {
  executePushChain,
  inspectPushPreconditions,
  pushAccessBlocker,
  isProtectedBranchName,
  uniqueBranchName,
  GitHubWriteError,
} from "../lib/github-write";
import {
  VERIFY_MANIFEST_PATH,
  checksFromAgentsMd,
  checksFromPackageJson,
  mergeChecks,
  parseVerifyManifest,
  summarizeChecks,
  unrunChecksStatement,
} from "../lib/verify-contract";
import { bindingIdOf } from "../identity/bindings";
import { describeBinding } from "../identity/identity";
import { assessPushPolicy, policyWarnings } from "../lib/push-policy";
import { assessCommandPolicy, summarizeCommandPolicy } from "../lib/command-policy";
import { COMPANION_PROTOCOL_VERSION } from "../companion/protocol";
import {
  companionCredentials,
  probeCompanion,
  runOnCompanion,
  STOPPED_BY_USER,
} from "../companion/companion-client";
import { describeRejections, planMaterialization } from "../companion/materialize-plan";
import { readFileContent } from "../lib/github-client";
import { CI_MAX_WAIT_MS, ciWorkflowPaths, planCiVerification } from "../lib/ci-plan";
import {
  dispatchWorkflow,
  findDispatchedRun,
  waitForRun,
} from "../lib/ci-client";
import { auditClaims, evidenceWarnings } from "../lib/evidence-audit";
import { appendMemory, MEMORY_PATH, parseMemoryFacts } from "../lib/project-memory";
import { delegateToolResult, pickResearchModel, runDelegateLoop } from "./delegate";
import { activeServers, callServerTool, findServer, listAllTools } from "../lib/mcp";
import { completeChat, completeChatWithTools } from "../lib/openrouter-client";
import { executeToolCall, parseToolArguments } from "../lib/tools";
import type { ChatConversation } from "../types";

// ── write_file ───────────────────────────────────────────────

/**
 * The conversation's CURRENT workspace. Every mutating executor must
 * start from this rather than from a snapshot captured earlier: a
 * workspace is a read-modify-write structure, and a stale snapshot
 * silently reverts whatever landed in between.
 *
 * `selectWorkspace` is what makes "current" mean it. Reading the map directly
 * answered "what does this thread have in memory", which is not the same
 * question and is wrong at exactly the moment it matters: right after the thread
 * moves to another repository, the entry in memory is the one it just left.
 * A write executor using it edits files in a repository the thread is no longer
 * on — memory-only, invisible, and pushed nowhere, which is worse than an error.
 */
async function latestWorkspace(conversationId: string): Promise<WorkspaceState | null> {
  const store = useChatStore.getState();
  const live = selectWorkspace(store, conversationId);
  if (live) return live;
  return store.ensureWorkspace(conversationId);
}

/**
 * Applies a workspace mutation and publishes it: store first, then a
 * debounced IDB flush. Returns the stored state so callers can diff
 * against it.
 */
function publishWorkspace(conversationId: string, ws: WorkspaceState): WorkspaceState {
  useChatStore.getState().setWorkspace(conversationId, ws);
  void flushWorkspaceSave(conversationId, ws);
  return ws;
}

// ── Evidence gathering for the approval gate ─────────────────

/**
 * Tool names the agent actually invoked in the CURRENT turn, read back
 * from the transcript rather than from a counter: the messages are the
 * record, and walking backwards from the tail stops at the user turn
 * that started it.
 */
function recentToolNames(conversation: ChatConversation | undefined): string[] {
  if (!conversation) return [];
  const names: string[] = [];
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i]!;
    if (m.role === "user" && !m.toolResult) break;
    if (m.toolCalls) names.push(...m.toolCalls.calls.map((c) => c.name));
  }
  return names;
}

/** The agent's most recent prose reply — what the reviewer will read as "the story" */
function lastAssistantClaim(conversation: ChatConversation | undefined): string {
  if (!conversation) return "";
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i]!;
    if (m.role !== "assistant") continue;
    if (m.toolCalls || m.toolResult || m.error) continue;
    if (m.content.trim()) return m.content;
  }
  return "";
}

export async function runWriteFile(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "write_file",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: typeof args.path === "string" ? args.path : "",
  });

  const path = typeof args.path === "string" ? args.path.trim() : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!path) return fail("Missing required argument: path");
  if (path.startsWith("/") || path.includes("..")) {
    return fail("Path must be repo-relative and cannot traverse upward.");
  }

  const token = useChatStore.getState().settings.github.token;
  const ws = await latestWorkspace(conversationId);
  if (!ws) {
    return fail("No workspace available — attach a repository with a write-capable token first.");
  }

  // Modifying an existing repo file requires loading it first
  if (!ws.files[path] && ws.tree.some((e) => e.path === path && e.type === "blob")) {
    const loaded = await readFile(ws, token, path);
    if (loaded.error || loaded.content === null) {
      return fail(loaded.error ?? `Could not load '${path}' before writing.`);
    }
    return commitWrite(conversationId, loaded.ws, path, content, started);
  }

  const result = writeFile(ws, path, content);
  if (!result.ok) return fail(result.error ?? "Write failed.");
  return commitWrite(conversationId, result.ws, path, content, started);
}

/**
 * Patch lines kept per step in the transcript. Step diffs are stored
 * in the persisted conversation, so they are capped well below the
 * 400-line diff the Changes pane shows.
 */
const TRANSCRIPT_PATCH_MAX_LINES = 120;

/**
 * What one mutation step did to one file, as a diff.
 *
 * Captured at the moment of the step rather than derived later: the
 * workspace only holds the file's CURRENT state, so a diff computed
 * at render time would show every later edit under an earlier step's
 * row. Additions/deletions also travel in the model-visible payload
 * (compact, and useful to the model); the patch stays UI-only.
 */
function fileChange(ws: WorkspaceState, path: string): StepChange | undefined {
  const file = ws.files[path];
  if (!file) return undefined;
  const status =
    file.status === "added" || file.status === "deleted" ? file.status : "modified";
  const change = diffFile(path, status, file.baseContent, file.content);
  const lines = change.patch.split("\n");
  const truncated = lines.length > TRANSCRIPT_PATCH_MAX_LINES;
  return {
    path,
    status,
    additions: change.additions,
    deletions: change.deletions,
    patch: truncated
      ? [...lines.slice(0, TRANSCRIPT_PATCH_MAX_LINES), "…[diff truncated]"].join("\n")
      : change.patch,
    truncated,
  };
}

async function commitWrite(
  conversationId: string,
  ws: Parameters<typeof writeFile>[0],
  path: string,
  content: string,
  started: number
): Promise<ToolCallResult> {
  useChatStore.getState().setWorkspace(conversationId, ws);
  void flushWorkspaceSave(conversationId, ws);
  // The workspace diverged from GitHub — cached read_file/list results
  // for this repo+branch are now stale (the model must see its own
  // edits, not the pre-edit repo content).
  clearToolCache();
  const file = ws.files[path];
  const status = file?.status ?? "added";
  const change = fileChange(ws, path);
  return {
    callId: "",
    name: "write_file",
    ok: true,
    data: {
      path,
      status,
      lines: content.split("\n").length,
      additions: change?.additions ?? 0,
      deletions: change?.deletions ?? 0,
      note: "File written to the workspace (not yet on GitHub).",
    },
    uiChange: change,
    durationMs: Date.now() - started,
    summary: path,
  };
}

// ── delete_file ──────────────────────────────────────────────

export async function runDeleteFile(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "delete_file",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: path,
  });
  if (!path) return fail("Missing required argument: path");

  const token = useChatStore.getState().settings.github.token;
  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  // Load before delete so the tombstone has base content for diffs
  if (!ws.files[path] && ws.tree.some((e) => e.path === path && e.type === "blob")) {
    const loaded = await readFile(ws, token, path);
    if (loaded.error || loaded.content === null) {
      return fail(loaded.error ?? `Could not load '${path}' before deleting.`);
    }
    const result = deleteFile(loaded.ws, path);
    if (!result.ok) return fail(result.error ?? "Delete failed.");
    useChatStore.getState().setWorkspace(conversationId, result.ws);
    clearToolCache();
    const change = fileChange(result.ws, path);
    return {
      callId: "",
      name: "delete_file",
      ok: true,
      data: {
        path,
        status: "deleted",
        additions: change?.additions ?? 0,
        deletions: change?.deletions ?? 0,
        note: "File deleted in the workspace (not yet on GitHub).",
      },
      uiChange: change,
      durationMs: Date.now() - started,
      summary: path,
    };
  }

  const result = deleteFile(ws, path);
  if (!result.ok) return fail(result.error ?? "Delete failed.");
  useChatStore.getState().setWorkspace(conversationId, result.ws);
  clearToolCache();
  const change = fileChange(result.ws, path);
  return {
    callId: "",
    name: "delete_file",
    ok: true,
    data: {
      path,
      status: "deleted",
      additions: change?.additions ?? 0,
      deletions: change?.deletions ?? 0,
      note: "File deleted in the workspace (not yet on GitHub).",
    },
    uiChange: change,
    durationMs: Date.now() - started,
    summary: path,
  };
}

// ── edit_file ────────────────────────────────────────────────

/**
 * Surgical edit of an existing workspace file. Whole-file rewrites
 * cost output tokens proportional to file size and silently destroy
 * any region the model did not have in view (especially after a
 * truncated read), so targeted replacement is the default path.
 */
export async function runEditFile(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "edit_file",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: path,
  });

  if (!path) return fail("Missing required argument: path");
  if (path.startsWith("/") || path.includes("..")) {
    return fail("Path must be repo-relative and cannot traverse upward.");
  }
  if (typeof args.oldString !== "string" || args.oldString.length === 0) {
    return fail("Missing required argument: oldString — use write_file to create a file.");
  }
  if (typeof args.newString !== "string") {
    return fail('Missing required argument: newString — pass "" to delete the matched text.');
  }
  const replaceAll = args.replaceAll === true;

  const token = useChatStore.getState().settings.github.token;
  let ws = await latestWorkspace(conversationId);
  if (!ws) {
    return fail("No workspace available — attach a repository with a write-capable token first.");
  }

  // An edit is only meaningful against real text: load the file first.
  if (!ws.files[path]) {
    if (!ws.tree.some((e) => e.path === path && e.type === "blob")) {
      return fail(`File '${path}' is not in the repository — use write_file to create it.`);
    }
    const loaded = await readFile(ws, token, path);
    if (loaded.error || loaded.content === null) {
      return fail(loaded.error ?? `Could not load '${path}' before editing.`);
    }
    ws = loaded.ws;
  }

  const file = ws.files[path];
  if (!file || file.status === "deleted") {
    return fail(`'${path}' is deleted in the workspace — use write_file to recreate it.`);
  }

  const outcome = applyStringEdit({
    current: file.content,
    oldString: args.oldString,
    newString: args.newString,
    replaceAll,
  });
  if (!outcome.ok) return fail(outcome.error ?? "Edit failed.");

  const result = writeFile(ws, path, outcome.content);
  if (!result.ok) return fail(result.error ?? "Edit failed.");

  publishWorkspace(conversationId, result.ws);
  // The workspace diverged from GitHub — cached reads for this
  // repo+branch would show the model its own pre-edit text.
  clearToolCache();

  const lines = outcome.content.split("\n").length;
  const change = fileChange(result.ws, path);
  return {
    callId: "",
    name: "edit_file",
    ok: true,
    data: {
      path,
      status: result.ws.files[path]?.status ?? "modified",
      replacements: outcome.replacements,
      lines,
      lineDelta: lines - file.content.split("\n").length,
      additions: change?.additions ?? 0,
      deletions: change?.deletions ?? 0,
      note: "Edit applied to the workspace (not yet on GitHub).",
    },
    uiChange: change,
    durationMs: Date.now() - started,
    summary: path,
  };
}

// ── search_workspace ─────────────────────────────────────────

/**
 * Grep over the working copy. This is the search the agent should
 * reach for while editing: it sees unpushed edits (GitHub search
 * cannot), works on any branch, and is not rate-limited. Files that
 * are not loaded yet are fetched on demand, bounded so one query
 * cannot drain the API budget.
 */
export async function runSearchWorkspace(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "search_workspace",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: query,
  });

  if (!query) return fail("Missing required argument: query");

  const mode: SearchMode = args.mode === "regex" ? "regex" : "text";
  if (mode === "regex") {
    try {
      new RegExp(query, "i");
    } catch (err) {
      return fail(
        `Invalid regular expression: ${err instanceof Error ? err.message : "parse error"}. Fix the pattern or use mode:'text'.`
      );
    }
  }

  const pathPrefix = typeof args.pathPrefix === "string" ? args.pathPrefix.trim() : "";
  const requested =
    typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
      ? Math.floor(args.maxResults)
      : 20;
  const maxResults = Math.min(Math.max(1, requested), SEARCH_MAX_RESULTS);

  const token = useChatStore.getState().settings.github.token;
  let ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  const candidates = pickSearchCandidates(ws, pathPrefix, SEARCH_MAX_FILE_BYTES);
  const matches: WorkspaceSearchMatch[] = [];
  const hitFiles = new Set<string>();
  let cappedFiles = 0;

  /** Scans one file; returns true when the global match cap is reached */
  const scan = (path: string, content: string): boolean => {
    const outcome = searchContent(path, content, query, mode);
    if (outcome.matches.length === 0) return false;
    hitFiles.add(path);
    if (outcome.capped) cappedFiles++;
    matches.push(...outcome.matches);
    return matches.length >= maxResults;
  };

  // Already-loaded files cost nothing to search.
  for (const p of candidates.loaded) {
    const f = ws.files[p];
    if (!f || f.status === "deleted") continue;
    if (scan(p, f.content)) break;
  }

  // Unloaded files are fetched on demand (bounded, sequential).
  let fetched = 0;
  let fetchFailed = 0;
  for (const p of candidates.unloaded) {
    if (matches.length >= maxResults || fetched >= SEARCH_MAX_FETCH_FILES) break;
    const loaded = await readFile(ws, token, p);
    if (loaded.error || loaded.content === null) {
      fetchFailed++;
      continue;
    }
    ws = loaded.ws;
    fetched++;
    if (scan(p, loaded.content)) break;
  }

  // Persist fetched files so they are readable by read_file — one
  // search warms the whole session.
  if (fetched > 0) {
    useChatStore.getState().setWorkspace(conversationId, ws);
    void flushWorkspaceSave(conversationId, ws);
  }

  const remaining = Math.max(0, candidates.unloaded.length - fetched);
  const notes: string[] = [];
  if (fetched > 0) {
    notes.push(`${fetched} file(s) were fetched from GitHub to search them (now available to read_file).`);
  }
  if (fetchFailed > 0) notes.push(`${fetchFailed} file(s) could not be fetched.`);
  if (remaining > 0 && matches.length < maxResults) {
    notes.push(
      `${remaining} candidate file(s) were not searched (fetch budget ${SEARCH_MAX_FETCH_FILES}); narrow pathPrefix to cover them.`
    );
  }
  if (cappedFiles > 0) {
    notes.push(`${cappedFiles} file(s) had more matches than shown.`);
  }

  const truncated = matches.length >= maxResults;
  return {
    callId: "",
    name: "search_workspace",
    ok: true,
    data: {
      query,
      mode,
      matchCount: matches.length,
      fileCount: hitFiles.size,
      matches,
      filesSearched: candidates.loaded.length + fetched,
      filesSkipped: candidates.skipped,
      truncated,
      notes,
      ...(matches.length === 0
        ? { note: "No matches in the working copy. Try search_code for the untouched repository, or a shorter query." }
        : {}),
    },
    durationMs: Date.now() - started,
    summary: `${matches.length} match(es) for "${query}"`,
  };
}

// ── get_workspace_diff ───────────────────────────────────────

/** Per-file patch budget defaults for get_workspace_diff */
const WORKSPACE_DIFF_PATCH_DEFAULT = 4_000;
const WORKSPACE_DIFF_PATCH_MAX = 12_000;

/**
 * The record of what the agent has changed since the base commit.
 * After context compaction this is the only trustworthy account of
 * the pending change set — reading it back beats trusting a summary.
 */
export async function runWorkspaceDiff(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const pathFilter = typeof args.path === "string" ? args.path.trim() : "";
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "get_workspace_diff",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: pathFilter || "all changes",
  });

  const requested =
    typeof args.maxPatchChars === "number" && Number.isFinite(args.maxPatchChars)
      ? Math.floor(args.maxPatchChars)
      : WORKSPACE_DIFF_PATCH_DEFAULT;
  const maxPatchChars = Math.min(Math.max(500, requested), WORKSPACE_DIFF_PATCH_MAX);

  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  const changes = collectChanges(ws);
  const selected = pathFilter ? changes.filter((c) => c.path === pathFilter) : changes;

  if (selected.length === 0) {
    return {
      callId: "",
      name: "get_workspace_diff",
      ok: true,
      data: {
        status: "clean",
        baseCommit: ws.baseCommitSha.slice(0, 8),
        fileCount: 0,
        files: [],
        note: pathFilter
          ? changes.length > 0
            ? `No pending changes to '${pathFilter}'. Changed files: ${changes.map((c) => c.path).join(", ")}.`
            : `No pending changes to '${pathFilter}' — the workspace matches the base commit.`
          : "The workspace matches the base commit — nothing has been changed yet.",
      },
      durationMs: Date.now() - started,
      summary: "clean",
    };
  }

  const files = selected.map((c) => {
    const wf = ws.files[c.path];
    const status = c.status === "unchanged" ? ("modified" as const) : c.status;
    const base = status === "added" ? "" : (wf?.baseContent ?? "");
    const content = status === "deleted" ? "" : (wf?.content ?? "");
    const diff = diffFile(c.path, status, base, content);
    const patch =
      diff.patch.length > maxPatchChars
        ? `${diff.patch.slice(0, maxPatchChars)}\n…[patch truncated — read the file or raise maxPatchChars]`
        : diff.patch;
    return {
      path: diff.path,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      patch,
    };
  });

  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  return {
    callId: "",
    name: "get_workspace_diff",
    ok: true,
    data: {
      status: "dirty",
      baseCommit: ws.baseCommitSha.slice(0, 8),
      branch: ws.workingBranch ?? ws.branch,
      fileCount: selected.length,
      additions,
      deletions,
      files,
      note: "Unpushed working-copy changes. Review before calling push_changes.",
    },
    durationMs: Date.now() - started,
    summary: `${files.length} file(s) changed, +${additions}/−${deletions}`,
  };
}

// ── create_working_branch ────────────────────────────────────

export async function runCreateWorkingBranch(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "create_working_branch",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: "",
  });

  const store = useChatStore.getState();
  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  const token = store.settings.github.token;
  const custom = typeof args.name === "string" ? args.name.trim() : "";
  if (custom && isProtectedBranchName(custom)) {
    return fail(`'${custom}' is a protected branch name — working branches must differ.`);
  }

  try {
    const branchName = custom && !isProtectedBranchName(custom)
      ? await uniqueBranchName(token, ws.owner, ws.repo, custom)
      : await uniqueBranchName(token, ws.owner, ws.repo, ws.branch);
    const { createBranch, getBranchHead } = await import("../lib/github-write");
    const head = await getBranchHead(token, ws.owner, ws.repo, ws.branch);
    await createBranch(token, ws.owner, ws.repo, branchName, head.commitSha);

    const next = { ...ws, workingBranch: branchName, updatedAt: Date.now() };
    useChatStore.getState().setWorkspace(conversationId, next);
    void flushWorkspaceSave(conversationId, next);

    return {
      callId: "",
      name: "create_working_branch",
      ok: true,
      data: { branch: branchName, from: ws.branch, sha: head.commitSha },
      durationMs: Date.now() - started,
      summary: branchName,
    };
  } catch (err) {
    const message = err instanceof GitHubWriteError ? err.message : err instanceof Error ? err.message : "Branch creation failed.";
    return fail(`${message} The push_changes flow can also create a branch automatically.`);
  }
}

/** Plain-object guard for model-supplied arguments */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── MCP (external tools over streamable HTTP) ────────────────

/**
 * Lists the tools every connected MCP server exposes.
 *
 * Errors are per-server and reported, never swallowed: a server that
 * refuses the browser origin (CORS) is the most common failure, and it
 * must be visible as exactly that — an empty list with no explanation
 * would look like "the tool you asked for does not exist".
 */
export async function runListMcpTools(
  _conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const configured = activeServers(useChatStore.getState().settings.mcpServers);
  // Optional narrowing: with several servers connected, a listing of all
  // of them is context the model usually does not need.
  const filter = typeof args.server === "string" ? args.server.trim() : "";
  const servers = filter ? configured.filter((s) => findServer([s], filter)) : configured;
  if (servers.length === 0) {
    return {
      callId: "",
      name: "list_mcp_tools",
      ok: true,
      data: {
        servers: [],
        note: "No MCP servers are connected. The user can add one in Chat Settings → Chat.",
      },
      durationMs: Date.now() - started,
      summary: "no MCP servers",
    };
  }

  const results = await listAllTools(servers);
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  return {
    callId: "",
    name: "list_mcp_tools",
    // Partial success is success: one unreachable server must not stop
    // the agent using the others.
    ok: true,
    data: {
      servers: results.map((r) => ({
        server: r.server.name,
        id: r.server.id,
        toolCount: r.tools.length,
        ...(r.error ? { error: r.error } : {}),
        tools: r.tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      })),
      ...(failed.length > 0
        ? {
            note: `${failed.length} server(s) did not answer. Their tools are unavailable this turn; tell the user rather than working around it silently.`,
          }
        : {}),
    },
    durationMs: Date.now() - started,
    summary:
      ok.length === 0
        ? `0/${servers.length} MCP servers reachable`
        : `${ok.reduce((n, r) => n + r.tools.length, 0)} MCP tool(s) from ${ok.length} server(s)`,
  };
}

/** Calls one tool on one connected MCP server */
export async function runCallMcpTool(
  _conversationId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const started = Date.now();
  // Checked before the request and again after it: an MCP server can sit on a
  // call for the better part of a minute, and a stopped turn must not be
  // reported as a tool that ran.
  if (signal?.aborted) {
    return {
      callId: "",
      name: "call_mcp_tool",
      ok: false,
      data: { error: STOPPED_BY_USER, cancelled: true },
      durationMs: 0,
      summary: "stopped by the user",
    };
  }
  const servers = useChatStore.getState().settings.mcpServers;
  const serverRef = typeof args.server === "string" ? args.server.trim() : "";
  const toolName = typeof args.tool === "string" ? args.tool.trim() : "";
  const toolArgs = isRecord(args.arguments) ? args.arguments : {};

  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "call_mcp_tool",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: toolName || "MCP call",
  });

  if (!serverRef || !toolName) {
    return fail('Missing required arguments: "server" and "tool" (see list_mcp_tools).');
  }
  const server = findServer(servers, serverRef);
  if (!server) {
    const known = activeServers(servers)
      .map((s) => `${s.name} (${s.id})`)
      .join(", ");
    return fail(
      known
        ? `No MCP server matches \`${serverRef}\`. Connected servers: ${known}.`
        : `No MCP servers are connected, so \`${serverRef}\` does not exist.`
    );
  }

  const outcome = await callServerTool(server, toolName, toolArgs, { signal });
  if (signal?.aborted) {
    return {
      callId: "",
      name: "call_mcp_tool",
      ok: false,
      data: { error: STOPPED_BY_USER, cancelled: true },
      durationMs: Date.now() - started,
      summary: "stopped by the user",
    };
  }
  if (!outcome.ok && outcome.error) return fail(outcome.error);

  return {
    callId: "",
    name: "call_mcp_tool",
    ok: outcome.ok,
    data: {
      server: server.name,
      tool: toolName,
      result: outcome.text,
      note: "Result of a tool running in an EXTERNAL service — report what changed to the user.",
    },
    durationMs: Date.now() - started,
    summary: `${server.name}/${toolName}`,
  };
}

// ── run_command (the only tool that can VERIFY) ──────────────

/**
 * The first few lines of a failure, for the ledger and the gate.
 *
 * stderr first, because a compiler and a test runner both put their verdict
 * there; stdout only when stderr is empty, because a failing Node process
 * often writes nothing to stderr but prints the assertion diff to stdout.
 */
function failureLines(outcome: { stdout: string; stderr: string }): string[] {
  const source = outcome.stderr.trim() || outcome.stdout.trim();
  if (!source) return [];
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
}

/**
 * Run a shell command in a real working tree, on the user's own machine.
 *
 * Every other tool in this file INFERS: `run_checks` reads a manifest and
 * reports which checks exist. This one runs the project's own command and
 * reports the exit code, which is the only thing in the product that can
 * turn "this should work" into "this passed".
 *
 * Three refusals are deliberate, and each is a way the tool would otherwise
 * lie:
 *
 *   • a blocked command is REFUSED rather than attempted quietly;
 *   • no companion means the command was NOT RUN — reported as unverified,
 *     never as success, because a green result the agent cannot support is
 *     worse than no result at all;
 *   • a non-zero exit is `ok: false`. A failing test run is a successful
 *     tool call carrying a failed verification, and the distinction is what
 *     stops "tests failed" from being summarised as "done".
 */
export async function runShellCommand(
  conversationId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const started = Date.now();
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const why = typeof args.why === "string" ? args.why.trim() : "";
  const fail = (error: string, summary: string): ToolCallResult => ({
    callId: "",
    name: "run_command",
    ok: false,
    data: { error, command, ...(why ? { why } : {}) },
    durationMs: Date.now() - started,
    summary,
  });

  if (!command) return fail("Pass a `command` to run.", "no command");
  // The user's Stop is checked before the command starts and again before
  // anything is recorded: this tool can run for ten minutes, and a result
  // that says "stopped" while the ledger says "verified" would be the one
  // lie this whole flow exists to prevent.
  if (signal?.aborted) return fail(STOPPED_BY_USER, "stopped by the user");
  if (command.length > 2_000) {
    return fail("That command line is too long for the user to review before it runs.", "too long");
  }

  const policy = assessCommandPolicy(command);
  const policyLine = summarizeCommandPolicy(policy);
  if (!policy.allowed) {
    return fail(
      `${policyLine ?? "Refused by policy."} Rewrite the command so it stays inside the workspace, ` +
        "or tell the user the exact command to run by hand — do not try a variant that hides what it does.",
      "refused by policy"
    );
  }

  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.", "no workspace");

  const store = useChatStore.getState();
  // Where the companion is, and the token to talk to it with. In an `npm run
  // dev` session the dev server started it and publishes both; a deployed build
  // reads them from the environment.
  const credentials = await companionCredentials();
  if (!credentials.origin) {
    return fail(
      `${command} was NOT RUN — ${credentials.error ?? "no companion is running"} Running real commands needs the ` +
        "local companion, which `npm run dev` starts for you (or `npm run companion` by hand). Report this change as " +
        "UNVERIFIED until it has run.",
      "not run — unverified"
    );
  }
  const probe = await probeCompanion(credentials.origin);
  if (!probe.available) {
    return fail(
      `${command} was NOT RUN — ${probe.error ?? "no companion answered"} Running real commands needs the ` +
        "local companion, which `npm run dev` starts for you. Report this change as " +
        "UNVERIFIED until it has run.",
      "not run — unverified"
    );
  }
  if (probe.protocolVersion !== null && probe.protocolVersion !== COMPANION_PROTOCOL_VERSION) {
    return fail(
      `The companion speaks protocol v${probe.protocolVersion} and this app expects v${COMPANION_PROTOCOL_VERSION}. ` +
        "It was NOT run: restart the companion so the two agree rather than letting it answer a request it does not understand.",
      "not run — version mismatch"
    );
  }

  const companionToken = credentials.token;
  if (!companionToken) {
    return fail(
      `${command} was NOT RUN — ${credentials.error ?? "no pairing token"}. ` +
        "In an `npm run dev` session the dev server provides one; a deployed build reads " +
        "VITE_COMPANION_TOKEN.",
      "not run — unpaired"
    );
  }

  // Only the workspace's own changes are written: with a repository ref the
  // companion checks out the base commit first, so the tree is the whole
  // project and the change set is the agent's delta on top of it.
  const plan = planMaterialization({
    base: [],
    changes: collectChanges(ws).map((change) => ({
      path: change.path,
      content: change.content,
      status: change.status,
    })),
  });
  const rejectedLine = describeRejections(plan);

  const ghToken = store.settings.github.token;
  const repo =
    ws.owner && ws.repo && ws.baseCommitSha
      ? {
          url: ghToken
            ? `https://x-access-token:${ghToken}@github.com/${ws.owner}/${ws.repo}.git`
            : `https://github.com/${ws.owner}/${ws.repo}.git`,
          ref: ws.baseCommitSha,
        }
      : undefined;

  const result = await runOnCompanion({
    origin: probe.origin,
    token: companionToken,
    conversationId,
    command,
    writes: plan.writes,
    deletes: plan.deletes,
    ...(repo ? { repo } : {}),
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
  }, signal ? { signal } : {});

  if (!result.ok) return fail(`The command was not run: ${result.error}`, "not run — unverified");
  if (signal?.aborted) return fail(STOPPED_BY_USER, "stopped by the user");

  const outcome = result.outcome;
  const passed = outcome.exitCode === 0;

  // Into the ledger, not just into the tool result. A result is read once and
  // forgotten; the push gate needs to know what was proven, about WHICH
  // revision, and how long ago — and a passing run of code that has since
  // changed is exactly the claim this ledger exists to stop.
  recordVerification(conversationId, {
    kind: "command",
    at: Date.now(),
    workspaceUpdatedAt: ws.updatedAt,
    ok: passed,
    summary: `\`${command}\` ${
      passed
        ? "exited 0"
        : outcome.timedOut
          ? "was killed after its timeout"
          : `exited ${outcome.exitCode}`
    } in ${outcome.durationMs}ms`,
    details: passed ? [] : failureLines(outcome),
    source: "run_command",
  });

  return {
    callId: "",
    name: "run_command",
    ok: passed,
    data: {
      command: outcome.command,
      ...(why ? { why } : {}),
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      timedOut: outcome.timedOut,
      outputTruncated: outcome.truncated,
      cwd: outcome.cwd,
      durationMs: outcome.durationMs,
      notes: outcome.notes,
      // Warnings the user approved, so a later reader can see what was risky
      // about a run that looked ordinary.
      warnings: policy.findings.map((finding) => finding.code),
      materialized: {
        files: plan.writes.length,
        deleted: plan.deletes.length,
        ...(rejectedLine ? { rejected: rejectedLine } : {}),
      },
      /**
       * The verdict, stated in the result rather than left to inference. A
       * model that has to derive "did this pass" from an exit code will,
       * under pressure, derive it wrongly.
       */
      verification: passed
        ? { status: "passed", evidence: `\`${command}\` exited 0 in ${outcome.cwd}.` }
        : {
            status: outcome.timedOut ? "timed-out" : "failed",
            evidence: `\`${command}\` ${outcome.timedOut ? "was killed after its timeout" : `exited ${outcome.exitCode}`}.`,
          },
    },
    durationMs: Date.now() - started,
    summary: `${passed ? "exit 0" : outcome.timedOut ? "timed out" : `exit ${outcome.exitCode}`} — ${command.slice(0, 48)}`,
  };
}

// ── verify_with_ci (the repository's own definition of green) ─

/** How long a single tool call will wait for CI before reporting "running" */
const CI_TOOL_WAIT_MS = 5 * 60_000;

/**
 * Verify a change by running the repository's own CI.
 *
 * This is the tier that reaches what the browser cannot: Python, Rust, a
 * Postgres service, a Docker build, a test matrix — none of it needs an
 * image, a language runtime, or a cent of compute, because the repository
 * already declares all of it and GitHub already runs it.
 *
 * It is also the slowest tier, so the honest failure modes matter more than
 * the happy one:
 *
 *   • it needs a PUSHED branch. CI runs against a ref, so with nothing
 *     pushed there is nothing to verify, and the result says to push first
 *     rather than dispatching into the void;
 *   • it needs `actions: write`, which is NOT the permission that pushes —
 *     a 403 is reported as a scope problem with its fix;
 *   • it reports "running" rather than a verdict when the wait runs out. The
 *     run is still going on GitHub; calling it either way would be
 *     inventing an answer.
 */
export async function runCiVerification(
  conversationId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const started = Date.now();
  const workflowPath = typeof args.workflow === "string" ? args.workflow.trim() : "";
  const fail = (error: string, summary: string): ToolCallResult => ({
    callId: "",
    name: "verify_with_ci",
    ok: false,
    data: { error, ...(workflowPath ? { workflow: workflowPath } : {}) },
    durationMs: Date.now() - started,
    summary,
  });

  if (signal?.aborted) return fail(STOPPED_BY_USER, "stopped by the user");

  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.", "no workspace");
  if (!ws.workingBranch) {
    return fail(
      "This change has not been pushed, and CI runs against a branch — so there is nothing to verify yet. " +
        "Push it first (the user reviews the diff), then verify.",
      "not pushed"
    );
  }

  const store = useChatStore.getState();
  const token = store.settings.github.token;
  if (!token) return fail("Connect GitHub before verifying with CI.", "no token");

  // Read the workflow files the tree already lists. A fetch per file is
  // cheap here (a repository has a handful) and keeps CI detection honest:
  // the plan is built from the files' actual triggers, not from their names.
  const paths = ciWorkflowPaths(ws.tree.map((entry) => entry.path));
  const workflows: { path: string; content: string }[] = [];
  const unreadable: string[] = [];
  for (const path of paths) {
    try {
      const file = await readFileContent(token, ws.owner, ws.repo, path, ws.branch);
      if (file.text !== null) workflows.push({ path, content: file.text });
      else unreadable.push(path);
    } catch {
      unreadable.push(path);
    }
  }

  const plan = planCiVerification({
    workflows,
    ref: ws.workingBranch,
    ...(workflowPath ? { preferredPath: workflowPath } : {}),
  });
  if (!plan.ok) {
    return fail(
      `${plan.message}${unreadable.length > 0 ? ` (Could not read: ${unreadable.join(", ")}.)` : ""}`,
      "cannot dispatch"
    );
  }

  const dispatchedAt = new Date().toISOString();
  const dispatch = await dispatchWorkflow({
    token,
    owner: ws.owner,
    repo: ws.repo,
    workflowPath: plan.workflow.path,
    ref: plan.ref,
    inputs: plan.inputs,
  });
  if (!dispatch.ok) return fail(dispatch.error, "dispatch refused");

  // The dispatch has no body, so the run is found by asking for runs created
  // after this moment — the newest-first list alone returns yesterday's green
  // run and every verification passes on it.
  let run = await findDispatchedRun({
    token,
    owner: ws.owner,
    repo: ws.repo,
    workflowPath: plan.workflow.path,
    ref: plan.ref,
    sinceIso: dispatchedAt,
  });
  if (!run) {
    // GitHub accepts a dispatch before the run is queryable. One short grace
    // poll, then an honest "dispatched but not visible yet" rather than a
    // retry loop that hides the real problem.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    run = await findDispatchedRun({
      token,
      owner: ws.owner,
      repo: ws.repo,
      workflowPath: plan.workflow.path,
      ref: plan.ref,
      sinceIso: dispatchedAt,
    });
  }
  if (!run) {
    return fail(
      `Dispatched ${plan.workflow.path} on ${plan.ref}, but no run has appeared yet. It may still be queued — ` +
        "nothing has been verified yet.",
      "dispatched, no run yet"
    );
  }

  const requestedWait = typeof args.maxWaitMs === "number" ? args.maxWaitMs : CI_TOOL_WAIT_MS;
  const waited = await waitForRun(
    { token, owner: ws.owner, repo: ws.repo, run },
    {
      maxWaitMs: Math.min(Math.max(requestedWait, 10_000), CI_MAX_WAIT_MS),
      ...(signal ? { signal } : {}),
    }
  );
  if (!waited.ok) return fail(`Watching the CI run failed: ${waited.error}`, "ci error");

  const verdict = waited.verdict;

  // Only a DEFINITIVE verdict is recorded. The ledger has one failure state,
  // and a run that is still going — or one that finished "skipped" and
  // therefore checked nothing — is not a failure, it is an absence of
  // evidence. Recording it as `ok: false` would make the next summary read
  // as "CI ran and FAILED", which is a different and wrong claim. Leaving it
  // unrecorded is what is honest: nothing then substantiates a green claim,
  // and the claim audit says so.
  if (verdict.status === "passed" || verdict.status === "failed" || verdict.status === "timed-out") {
    recordVerification(conversationId, {
      kind: "ci",
      at: Date.now(),
      workspaceUpdatedAt: ws.updatedAt,
      ok: verdict.status === "passed",
      summary: `${plan.workflow.label} — ${verdict.status} (${verdict.evidence})`,
      details: verdict.status === "passed" ? [] : [verdict.evidence],
      source: "verify_with_ci",
    });
  }

  return {
    callId: "",
    name: "verify_with_ci",
    // Only a definitive pass is a success. A skipped, neutral or still-running
    // run is not verification, and reporting it as one is the failure this
    // whole tier exists to remove.
    ok: verdict.status === "passed",
    data: {
      workflow: plan.workflow.path,
      workflowLabel: plan.workflow.label,
      ref: plan.ref,
      why: plan.reason,
      runId: run.id,
      runUrl: run.htmlUrl,
      status: verdict.status,
      authoritativelyGreen: verdict.authoritativelyGreen,
      evidence: verdict.evidence,
      jobs: plan.workflow.jobs,
      ...(unreadable.length > 0 ? { unreadableWorkflows: unreadable } : {}),
      cost: "Runs on the repository's own CI — no sandbox, no cloud compute.",
    },
    durationMs: Date.now() - started,
    summary: `ci: ${verdict.status} — ${plan.workflow.label}`,
  };
}

// ── run_checks (the verification contract) ───────────────────

/** Best-effort read of one repo file: workspace first, then GitHub */
async function readRepoFile(
  conversationId: string,
  path: string
): Promise<string | null> {
  const store = useChatStore.getState();
  // Fail closed here too: a file read from another repository's working copy is
  // a wrong answer, and the fallback below reads the RIGHT repository.
  const ws = selectWorkspace(store, conversationId);
  const local = ws?.files[path];
  if (local && local.status !== "deleted") return local.content;
  const repo = store.conversations.find((c) => c.id === conversationId)?.repoContext;
  const token = store.settings.github.token;
  if (!repo || !token) return null;
  try {
    const { readFileContent } = await import("../lib/github-client");
    const file = await readFileContent(token, repo.owner, repo.repo, path, repo.branch);
    return file.text;
  } catch {
    return null;
  }
}

/**
 * Discovers every verification check this repository declares.
 * Exported because the push gate reuses it: a reviewer should know which
 * declared checks were never executed, not just which ones the model
 * claimed.
 */
export async function discoverChecks(conversationId: string): Promise<{
  checks: ReturnType<typeof mergeChecks>;
  notes: string[];
}> {
  const notes: string[] = [];
  const [manifestRaw, packageRaw, agentsRaw] = await Promise.all([
    readRepoFile(conversationId, VERIFY_MANIFEST_PATH),
    readRepoFile(conversationId, "package.json"),
    readRepoFile(conversationId, "AGENTS.md"),
  ]);

  const manifest = parseVerifyManifest(manifestRaw);
  if (manifest.error) notes.push(manifest.error);
  const checks = mergeChecks(
    manifest.checks,
    checksFromPackageJson(packageRaw),
    checksFromAgentsMd(agentsRaw)
  );
  return { checks, notes };
}

/** Timeout for one external check run (a test suite can be slow) */
const CHECK_RUN_TIMEOUT_MS = 180_000;

/**
 * Runs the in-browser type check over the workspace.
 *
 * A compiler in a worker is what gives the agent a signal that can see a
 * type error at all — without it the agent's only build feedback was
 * type-blind (`const x: string = 42` ran cleanly) while its own
 * instructions told it to verify before pushing.
 */
async function runLocalTypecheck(
  conversationId: string,
  ws: import("../types").WorkspaceState
): Promise<import("../lib/typecheck-client").TypecheckResult> {
  const { runTypecheck } = await import("../lib/typecheck-client");
  const files = Object.entries(ws.files)
    .filter(([, file]) => file.status !== "deleted")
    .map(([path, file]) => ({ path, content: file.content }));
  const changedPaths = Object.entries(ws.files)
    .filter(([, file]) => file.status !== "unchanged")
    .map(([path]) => path);
  return runTypecheck({
    files,
    tsconfigRaw:
      ws.files["tsconfig.json"]?.content ??
      ws.files["jsconfig.json"]?.content ??
      null,
    treePaths: ws.tree.map((entry) => entry.path),
    changedPaths,
  });
}

/**
 * Reports the repository's declared verification checks, and executes
 * them when this BUILD has a runner configured for it.
 *
 * The uncomfortable truth this tool exists to make usable: an agent without
 * it says "all tests pass" and is believed. With it, the agent can say
 * "this repo declares four checks, I ran none of them, here are the
 * commands" — which is checkable. When a runner IS configured
 * (`VITE_CHECKS_ENDPOINT`, chosen by whoever builds the app) the declared
 * commands are executed there and real results come back; otherwise the
 * local typecheck still runs, and the tiers that need a machine — the
 * companion, CI — are the ones the agent is told to use.
 */
export async function runRunChecks(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const ws = await latestWorkspace(conversationId);
  if (!ws) {
    return {
      callId: "",
      name: "run_checks",
      ok: false,
      data: { error: "No workspace available — attach a repository first." },
      durationMs: Date.now() - started,
      summary: "no workspace",
    };
  }

  const { checks, notes } = await discoverChecks(conversationId);
  const statement = unrunChecksStatement(checks);
  const wantsRun = args.run === true;
  // Configured by whoever BUILDING the app, not by the person using it: an
  // external checks runner is deployment plumbing, and a text field in Chat
  // settings asked a user to describe their own CI infrastructure. The two
  // tiers everyone actually has are `run_command` (the local companion,
  // on their machine) and `verify_with_ci` (the repository's own workflow).
  const endpoint = (import.meta.env?.VITE_CHECKS_ENDPOINT as string | undefined)?.trim() || "";

  // ── No runner configured: run what CAN run here, report the rest ──
  if (!wantsRun || !endpoint) {
    // The in-browser type check needs no runner and no network, so it runs
    // regardless of `run` — it is the only real verification available in
    // this environment, and a report that silently skipped it would be the
    // same "declared but unverified" story this tool exists to end.
    const typecheck = await runLocalTypecheck(conversationId, ws);
    // Recorded as evidence, not just returned: a type error found now and
    // visible at the push gate is the difference between "it compiles" and
    // "nobody checked". An unavailable run records nothing at all — an
    // entry that says "not checked" would still count as an entry.
    if (typecheck.ok) {
      const reported = typecheck.classification.reported.length;
      const omitted = typecheck.classification.omitted;
      recordVerification(conversationId, {
        kind: "typecheck",
        at: Date.now(),
        workspaceUpdatedAt: ws.updatedAt,
        ok: reported === 0,
        summary:
          reported === 0
            ? `0 errors across ${typecheck.checkedFiles} file(s)`
            : `${reported} error(s) across ${typecheck.checkedFiles} file(s)${omitted > 0 ? ` (${omitted} more omitted)` : ""}`,
        details: typecheck.classification.reported
          .slice(0, 12)
          .map((d) => `${d.file ?? "(project)"}${d.line ? `:${d.line}` : ""} TS${d.code}: ${d.message.split("\n")[0] ?? d.message}`),
        source: "run_checks",
      });
    }
    return {
      callId: "",
      name: "run_checks",
      ok: true,
      data: {
        status: typecheck.ok
          ? "typecheck-ran-in-browser"
          : wantsRun && !endpoint
            ? "not-executed-no-runner"
            : "declared",
        checks: checks.map((c) => ({ label: c.label, command: c.command, source: c.source })),
        // The statement now covers only what the local run could NOT do.
        statement: [
          typecheck.ok
            ? "Type checking DID run — in the browser, over the workspace's own sources. Everything else below did not run."
            : null,
          statement,
        ]
          .filter(Boolean)
          .join(" "),
        executed: typecheck.ok,
        localChecks: [
          {
            label: "Type check (in-browser)",
            ran: typecheck.ok,
            report: typecheck.report,
            ...(typecheck.unavailableReason ? { unavailable: typecheck.unavailableReason } : {}),
          },
        ],
        ...(notes.length > 0 ? { notes } : {}),
        note:
          "A type check is not a test run and not a build. The test, lint and build commands above still need a runner " +
          "(Chat Settings → checks endpoint) or the user's own terminal, so report their outcome as unverified until then.",
      },
      durationMs: Date.now() - started,
      summary: typecheck.ok
        ? `${summarizeChecks(checks)} · typecheck ran`
        : summarizeChecks(checks),
    };
  }

  // ── Runner configured: POST the declared commands + the change set ──
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_RUN_TIMEOUT_MS);
  try {
    const changes = collectChanges(ws);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        repo: { owner: ws.owner, repo: ws.repo, branch: ws.branch },
        checks: checks.map((c) => ({ id: c.id, label: c.label, command: c.command })),
        files: changes.map((f) => ({ path: f.path, content: f.content })),
      }),
    });
    if (!response.ok) {
      return {
        callId: "",
        name: "run_checks",
        ok: false,
        data: {
          status: "runner-error",
          error: `The checks runner returned HTTP ${response.status}.`,
          statement,
        },
        durationMs: Date.now() - started,
        summary: "runner error",
      };
    }
    const json = (await response.json()) as {
      results?: Array<{ id?: string; ok?: boolean; output?: string }>;
      error?: string;
    };
    const results = (json.results ?? []).map((r) => ({
      id: r.id ?? "unknown",
      ok: r.ok === true,
      output: typeof r.output === "string" ? r.output.slice(0, 2_000) : undefined,
    }));
    const failed = results.filter((r) => !r.ok);

    return {
      callId: "",
      name: "run_checks",
      ok: failed.length === 0,
      data: {
        status: "executed",
        executed: true,
        ran: results.length,
        failed: failed.map((r) => r.id),
        results,
        ...(json.error ? { runnerNote: json.error } : {}),
      },
      durationMs: Date.now() - started,
      summary:
        results.length === 0
          ? "runner returned no results"
          : failed.length === 0
            ? `${results.length} check(s) passed`
            : `${failed.length}/${results.length} check(s) failed`,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      callId: "",
      name: "run_checks",
      ok: false,
      data: {
        status: aborted ? "runner-timeout" : "runner-unreachable",
        error: aborted
          ? `The checks runner did not finish within ${Math.round(CHECK_RUN_TIMEOUT_MS / 1000)}s.`
          : `Could not reach the checks runner: ${err instanceof Error ? err.message : "unknown error"}`,
        statement,
      },
      durationMs: Date.now() - started,
      summary: aborted ? "runner timeout" : "runner unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── delegate (nested read-only research) ─────────────────────

/**
 * Hands a research task to a nested read-only agent.
 *
 * Exploration is the most context-hungry thing a coding agent does, and
 * the parent needs the CONCLUSION, not the file bodies it read to reach
 * it. The helper runs its own loop on its own message list, so those
 * bodies — and the 60k tokens they would have cost for the rest of the
 * conversation — never enter the parent's context at all.
 *
 * Model routing is the second half of the point: the helper defaults to
 * the cheapest tool-capable FREE model the catalog knows about, because
 * grepping a repository is not frontier work. That is the harness putting
 * each model where it is cheapest instead of paying the selected model's
 * rate for every search.
 */
export async function runDelegate(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const fail = (error: string, status = "failed"): ToolCallResult => ({
    callId: "",
    name: "delegate",
    ok: false,
    data: { status, error },
    durationMs: Date.now() - started,
    summary: "delegation failed",
  });

  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) {
    return fail('Missing required argument: "task" — state what the helper should find out.');
  }

  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const repo = conversation?.repoContext;
  if (!repo) {
    return fail(
      "No repository is attached to this conversation — a delegated research task has nothing to search.",
      "unavailable"
    );
  }
  const apiKey = store.settings.apiKey?.trim();
  if (!apiKey) return fail("No OpenRouter API key is configured.", "unavailable");

  const conversationModel = conversation?.model ?? store.settings.defaultModel;
  const choice = pickResearchModel(conversationModel);
  const maxIterations =
    typeof args.maxIterations === "number" && Number.isFinite(args.maxIterations)
      ? Math.floor(args.maxIterations)
      : undefined;

  try {
    const outcome = await runDelegateLoop(
      {
        task,
        modelId: choice.modelId,
        repo,
        apiKey,
        maxIterations,
        modelReason: choice.reason,
      },
      {
        complete: completeChatWithTools,
        // Read tools execute in tools.ts; search_workspace is a workspace
        // read, which lives here. Both are on the delegate allowlist, and
        // the loop re-checks that allowlist before calling this.
        executeRead: (call) => {
          if (call.name === "search_workspace") {
            return runSearchWorkspace(conversationId, parseToolArguments(call.arguments));
          }
          return executeToolCall(call, {
            token: store.settings.github.token,
            repo,
            conversationId,
          });
        },
      }
    );

    const result = delegateToolResult(outcome, { task });
    return {
      ...result,
      data: { ...(result.data as Record<string, unknown>), routedBy: choice.reason },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "The helper agent failed unexpectedly.");
  }
}

// ── remember (durable project memory) ────────────────────────

/**
 * Records one durable fact about the repository into .intab/memory.md.
 *
 * The value is not the file itself but what it removes: the same three
 * facts (how to run tests, which module owns what, the gotcha that ate
 * an hour) get rediscovered from scratch every new conversation. Memory
 * is written THROUGH the workspace, so it obeys the same review and push
 * gate as any other change — nothing about the repo moves without the
 * user seeing it.
 */
export async function runRemember(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "remember",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: "project memory",
  });

  const fact = typeof args.fact === "string" ? args.fact.trim() : "";
  if (!fact) {
    return fail('Missing required argument: "fact" (one sentence of durable, repo-specific fact).');
  }

  const store = useChatStore.getState();
  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");
  const token = store.settings.github.token;

  // The memory file may exist in the repository but not be loaded yet;
  // writeFile refuses to overwrite a path it has not read (for good
  // reason), so load it first when the tree knows about it.
  let current = ws;
  if (!current.files[MEMORY_PATH] && current.tree.some((e) => e.path === MEMORY_PATH)) {
    const loaded = await readFile(current, token, MEMORY_PATH);
    if (!loaded.error) current = loaded.ws;
  }

  const existing = current.files[MEMORY_PATH]?.content ?? null;
  const { content, added, entry } = appendMemory(existing, fact);
  if (!added) {
    return {
      callId: "",
      name: "remember",
      ok: true,
      data: {
        status: "already-recorded",
        path: MEMORY_PATH,
        fact,
        note: "This fact is already in project memory — nothing was written.",
      },
      durationMs: Date.now() - started,
      summary: "already recorded",
    };
  }

  const result = writeFile(current, MEMORY_PATH, content);
  if (!result.ok) return fail(result.error ?? `Could not write ${MEMORY_PATH}.`);
  publishWorkspace(conversationId, result.ws);

  return {
    callId: "",
    name: "remember",
    ok: true,
    data: {
      status: "recorded",
      path: MEMORY_PATH,
      entry,
      totalFacts: parseMemoryFacts(content).length,
      note: `Recorded in project memory. It reaches GitHub with your next push_changes, where the user reviews it.`,
    },
    durationMs: Date.now() - started,
    summary: fact.slice(0, 50),
  };
}

// ── push_changes (the approval gate) ─────────────────────────

export async function runPushChanges(
  conversationId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolCallResult> {
  const started = Date.now();
  if (signal?.aborted) {
    return {
      callId: "",
      name: "push_changes",
      ok: false,
      data: { error: STOPPED_BY_USER, cancelled: true },
      durationMs: 0,
      summary: "stopped by the user",
    };
  }
  const fail = (error: string): ToolCallResult => ({
    callId: "",
    name: "push_changes",
    ok: false,
    data: { error },
    durationMs: Date.now() - started,
    summary: "",
  });

  const store = useChatStore.getState();
  const ws = await latestWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  const changes: PushFile[] = collectChanges(ws);
  if (changes.length === 0) {
    return fail("No workspace changes to push — edit files with write_file first.");
  }
  if (store.pendingPush) {
    return fail("A push is already awaiting approval — wait for the user to decide.");
  }

  // ── Automated policy gate ──
  // Runs BEFORE the human gate, because a credential in the diff is not
  // a judgement call: once committed it is compromised,
  // and no amount of careful reviewing undoes that. The message goes
  // back to the model so it can fix the change set itself.
  const policy = assessPushPolicy({
    files: changes.map((f) => ({ path: f.path, content: f.content })),
  });
  if (policy.blocked) {
    return {
      callId: "",
      name: "push_changes",
      ok: false,
      data: {
        status: "blocked-by-policy",
        error: policy.blockReason,
        paths: policy.findings.flatMap((f) => f.paths),
        action:
          "Remove the credential from the file and read it from an environment variable or secret store instead, " +
          "then call push_changes again. If the value was already live, it must be rotated — assume it is compromised.",
      },
      durationMs: Date.now() - started,
      summary: "push blocked: credential in diff",
    };
  }

  const commitMessage =
    typeof args.commitMessage === "string" && args.commitMessage.trim()
      ? args.commitMessage.trim()
      : "Agent changes";
  const prTitle =
    typeof args.prTitle === "string" && args.prTitle.trim()
      ? args.prTitle.trim()
      : commitMessage;
  const prBody = typeof args.prBody === "string" ? args.prBody.trim() : undefined;

  // Build the per-file diffs for the approval UI
  const diffs = changes.map((f) => {
    const wf = ws.files[f.path];
    const base = f.status === "added" ? "" : wf?.baseContent ?? "";
    const content = f.status === "deleted" ? "" : (f.content ?? "");
    const status = f.status === "unchanged" ? ("modified" as const) : (f.status as "modified" | "added" | "deleted");
    return diffFile(f.path, status, base, content);
  });

  const branchName = ws.workingBranch ?? (await uniqueBranchName(store.settings.github.token, ws.owner, ws.repo, ws.branch));

  // ── Preflight: is this push still safe and possible? ──
  // Advisory, never fatal: writes are path-scoped, so a push cannot
  // corrupt unrelated files. But someone approving a diff against a
  // stale base — or holding a read-only token — should find out here
  // rather than after the commit.
  const warnings: PushWarning[] = [];
  try {
    const preflight = await inspectPushPreconditions(store.settings.github.token, {
      owner: ws.owner,
      repo: ws.repo,
      baseBranch: ws.branch,
      baseCommitSha: ws.baseCommitSha,
      files: changes.map((f) => ({ path: f.path, baseSha: f.baseSha })),
    });
    // A reported read-only token cannot be approved into working. Asking
    // the user to review a diff that is guaranteed to fail with 403 spends
    // their attention on a decision they cannot make differently, and the
    // failure then arrives looking like a mysterious access problem. Say
    // it up front, with the fix, and never open the gate for it.
    const accessBlock = pushAccessBlocker(preflight, ws);
    if (accessBlock) {
      return {
        callId: "",
        name: "push_changes",
        ok: false,
        data: {
          status: "no-write-access",
          error: accessBlock,
          action:
            "Tell the user exactly which access is missing and stop calling push_changes until they reconnect " +
            "GitHub with write access. Nothing is lost — every workspace change stays in the workspace and will be " +
            "pushed by the next call once the token can write.",
        },
        durationMs: Date.now() - started,
        summary: "push blocked: no write access",
      };
    }
    if (preflight.baseMoved) {
      const upstream = preflight.upstreamChanged;
      warnings.push({
        kind: upstream.length > 0 ? "upstream-changed" : "base-moved",
        message:
          upstream.length > 0
            ? `${upstream.length} of the files you changed also changed on '${ws.branch}' since this workspace loaded: ${upstream.slice(0, 4).join(", ")}${upstream.length > 4 ? ", …" : ""}. Approving replaces the newer upstream content at those paths.`
            : `'${ws.branch}' advanced since this workspace loaded (${ws.baseCommitSha.slice(0, 7)} → ${preflight.currentHeadSha.slice(0, 7)}). The change set still applies cleanly, but re-read any file you are unsure about.`,
      });
    }
  } catch {
    // Advisory only — a failed probe must never block the gate.
  }

  // ── Policy + evidence warnings for the reviewer ──
  warnings.push(...policyWarnings(policy));

  // The gap this closes: a summary is prose until it is compared against the
  // change set, the tools that actually ran, and the evidence the ledger
  // holds. There IS a shell now (run_command) and a CI tier
  // (verify_with_ci), so the audit is evidence-based rather than assuming
  // nothing could have run — a passing test run must not be flagged, and a
  // FAILING one must not pass unnoticed.
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const toolsUsed = recentToolNames(conversation);
  // Real evidence: what was actually run against THIS revision of the
  // workspace, with its age and its staleness. Distinct from the claim
  // audit below — this is what happened, that is what was said.
  const verification = verificationEvidence(conversationId, { workspaceUpdatedAt: ws.updatedAt });
  warnings.push(...verificationWarnings(verification));

  const evidence = auditClaims({
    claim: lastAssistantClaim(conversation),
    changedPaths: changes.map((f) => f.path),
    toolsUsed,
    typecheck: verification.find((v) => v.kind === "typecheck") ?? null,
    // The strongest evidence there is, and the two kinds a reviewer most
    // wants to see in the gate: a real command, and the repository's CI.
    command: verification.find((v) => v.kind === "command") ?? null,
    ci: verification.find((v) => v.kind === "ci") ?? null,
  });
  warnings.push(...evidenceWarnings(evidence));

  // The repository's own definition of done, checked against reality. A
  // reviewer looking at a diff has no idea that `npm test` was never run
  // — this is the one line that tells them, and it comes from the repo's
  // files rather than from the agent's summary.
  try {
    const { checks } = await discoverChecks(conversationId);
    if (checks.length > 0) {
      warnings.push({
        kind: "checks",
        message:
          `This repository declares ${checks.length} check(s), and none of them can run in this workspace: ` +
          `${checks.map((c) => `\`${c.command}\``).join(", ")}. The diff has not been verified by any of them — run them before merging.`,
      });
    }
  } catch {
    // Discovery is best-effort: a failed read must never block the gate.
  }

  // ── Open the gate: pause the agent loop until the user decides ──
  //
  // The gate is a WAIT, and a wait has to be cancellable: without this, Stop
  // during an approval dialog left the modal on screen and the turn parked
  // behind it. Aborting resolves the gate as a rejection (the modal closes),
  // and the result below says STOPPED rather than "rejected" — the model must
  // not read a user's stop as a decision about the change set.
  const onAbort = () =>
    useChatStore.getState().resolvePushApproval(false, STOPPED_BY_USER);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const decision = await store.requestPushApproval({
    conversationId,
    createdAt: Date.now(),
    branchName,
    baseBranch: ws.branch,
    commitMessage,
    prTitle,
    prBody,
    changes: diffs,
    stats: {
      files: diffs.length,
      additions: diffs.reduce((s, d) => s + d.additions, 0),
      deletions: diffs.reduce((s, d) => s + d.deletions, 0),
    },
    ...(verification.length > 0 ? { verification: verificationLines(verification) } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  if (signal) signal.removeEventListener("abort", onAbort);

  // The user stopped the turn while the gate was open. Reported as a stop, not
  // as a rejection: the change set was never judged.
  if (signal?.aborted) {
    return {
      callId: "",
      name: "push_changes",
      ok: false,
      data: { status: "cancelled", error: STOPPED_BY_USER, cancelled: true },
      durationMs: Date.now() - started,
      summary: "stopped by the user",
    };
  }

  if (!decision.approved) {
    return {
      callId: "",
      name: "push_changes",
      ok: false,
      data: {
        status: "rejected",
        note: decision.note ?? null,
        message: decision.note
          ? `The user rejected the push with a note: ${decision.note}`
          : "The user rejected the push. Ask how to adjust the changes, or refine them and try push_changes again.",
      },
      durationMs: Date.now() - started,
      summary: "push rejected",
    };
  }

  // ── Approved: execute the GitHub write chain ──
  // Approval is per file, not per change set: the user may have unchecked
  // paths they want held back. Those are dropped from THIS commit only —
  // the diff, the content and the effect log all stay in the workspace.
  const openPr = decision.openPr ?? true;
  const selection = partitionPushChanges(changes, decision.excludePaths);
  if (selection.push.length === 0) {
    return {
      callId: "",
      name: "push_changes",
      ok: false,
      data: {
        status: "nothing-selected",
        excluded: selection.excluded.map((f) => f.path),
        error: "The user unchecked every changed file at the approval gate, so nothing was committed.",
        action:
          "Nothing was lost — every change stays in the workspace. Ask what they want different about the " +
          "excluded files, apply it, then call push_changes again.",
      },
      durationMs: Date.now() - started,
      summary: "push: nothing selected",
    };
  }
  const pushedPaths = new Set(selection.push.map((f) => f.path));
  const pushedDiffs = diffs.filter((d) => pushedPaths.has(d.path));
  const exclusionNote = describeExclusions(selection.excluded);

  // Proof-carrying PR: whatever really ran — the in-browser type check, a
  // command, the repository's CI — is appended to the pull request body,
  // with its verdict, its age and an explicit list of what was NOT run. A
  // reviewer reading the PR on GitHub sees the evidence without trusting a
  // summary.
  const proof = proofSection(verification);
  const withProof = (body: string): string => (proof ? `${body}\n\n${proof}` : body);
  try {
    const result = await executePushChain(store.settings.github.token, {
      owner: ws.owner,
      repo: ws.repo,
      baseBranch: ws.branch,
      baseCommitSha: ws.baseCommitSha,
      commitMessage,
      prTitle,
      prBody: withProof(prBody ?? `Agent-generated changes pushed from InTab.\n\n${summarizeChanges(pushedDiffs)}`),
      files: selection.push.map((f) => ({ path: f.path, content: f.content, baseSha: f.baseSha })),
      createBranchIfNeeded: true,
      workingBranch: ws.workingBranch ?? branchName,
    });

    let prUrl: string | undefined;
    let prNumber: number | undefined;
    if (openPr) {
      const { openPullRequest } = await import("../lib/github-write");
      const pr = await openPullRequest(
        store.settings.github.token,
        ws.owner,
        ws.repo,
        result.branchName,
        ws.branch,
        prTitle,
        withProof(prBody ?? `Agent-generated changes pushed from InTab.\n\n${summarizeChanges(pushedDiffs)}`)
      );
      prUrl = pr.htmlUrl;
      prNumber = pr.number;
    }

    // Mark only the committed files as pushed and pin the new base. Files
    // the user held back keep their pending status — see markPushed().
    const pushed = (await import("../workspace/workspace")).markPushed(
      ws,
      result.commitSha,
      selection.push.map((f) => f.path)
    );
    const { invalidateRepoCache } = await import("../lib/github-client");
    invalidateRepoCache();
    // The branch head moved: cached tree/read results describe the
    // old base commit and must not be served again.
    clearToolCache();
    useChatStore.getState().setWorkspace(conversationId, pushed);
    void flushWorkspaceSave(conversationId, pushed);

    return {
      callId: "",
      name: "push_changes",
      ok: true,
      data: {
        status: "pushed",
        branch: result.branchName,
        commit: result.commitSha,
        prUrl,
        prNumber,
        files: selection.push.length,
        ...(verification.length > 0 ? { verification: verificationLines(verification) } : {}),
        ...(selection.excluded.length > 0
          ? {
              excluded: selection.excluded.map((f) => f.path),
              excludedNote: exclusionNote,
            }
          : {}),
        ...(evidence.length > 0
          ? {
              evidenceWarning:
                "The reviewer was told that part of your summary is not backed by the change set " +
                `${evidence.map((f) => f.message).join(" ")} Correct the record in your next message.`,
            }
          : {}),
      },
      durationMs: Date.now() - started,
      summary:
        prUrl ??
        (selection.excluded.length > 0
          ? `${result.branchName} (${selection.excluded.length} file(s) held back)`
          : result.branchName),
    };
  } catch (err) {
    const message =
      err instanceof GitHubWriteError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The push failed unexpectedly.";
    return {
      callId: "",
      name: "push_changes",
      ok: false,
      data: { status: "failed", error: message },
      durationMs: Date.now() - started,
      summary: "push failed",
    };
  }
}

// ── Workspace management helpers (revert UI) ─────────────────

export async function revertWorkspaceFile(conversationId: string, path: string): Promise<void> {
  const ws = selectWorkspace(useChatStore.getState(), conversationId);
  if (!ws) return;
  const next = revertFile(ws, path);
  useChatStore.getState().setWorkspace(conversationId, next);
}

export async function revertEntireWorkspace(conversationId: string): Promise<void> {
  const ws = selectWorkspace(useChatStore.getState(), conversationId);
  if (!ws) return;
  const next = revertAll(ws);
  useChatStore.getState().setWorkspace(conversationId, next);
}

/**
 * Undoes the newest agent workspace mutation (effect log, LIFO).
 * One click = one step back in the agent's edit history.
 */
export async function undoLastWorkspaceMutation(conversationId: string): Promise<void> {
  const ws = selectWorkspace(useChatStore.getState(), conversationId);
  if (!ws) return;
  const next = undoLast(ws);
  useChatStore.getState().setWorkspace(conversationId, next);
}
