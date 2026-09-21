// ============================================================
// Agent Actions — Executor Bridge for Write/Ship/Preview Tools
// ============================================================
// tools.ts stays UI-free and store-free for the read tools; this
// module owns the coding-agent tools that need the chat store
// (workspace, gate), the GitHub write client, and the preview
// runtime. chat-runner.ts routes write/ship/feedback calls here.

import { useChatStore } from "@/stores/chat.store";
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
import type { PushWarning, ToolCallResult, WorkspaceState } from "../types";
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
  isProtectedBranchName,
  uniqueBranchName,
  GitHubWriteError,
} from "../lib/github-write";
import { schedulePreviewBuild, runPreviewBuild } from "../preview/preview-runtime";
import { runJsInPreview, queryPreviewDom } from "../preview/preview-bridge";
import { usePreviewStore } from "../preview/preview.store";
import { assessPushPolicy, policyWarnings } from "../lib/push-policy";
import { auditClaims, evidenceWarnings } from "../lib/evidence-audit";
import { appendMemory, MEMORY_PATH, parseMemoryFacts } from "../lib/project-memory";
import { delegateToolResult, pickResearchModel, runDelegateLoop } from "./delegate";
import { completeChatWithTools } from "../lib/openrouter-client";
import { executeToolCall, parseToolArguments } from "../lib/tools";
import type { ChatConversation } from "../types";

// ── write_file ───────────────────────────────────────────────

/**
 * The conversation's CURRENT workspace. Every mutating executor must
 * start from this rather than from a snapshot captured earlier: a
 * workspace is a read-modify-write structure, and a stale snapshot
 * silently reverts whatever landed in between.
 */
async function latestWorkspace(conversationId: string): Promise<WorkspaceState | null> {
  const store = useChatStore.getState();
  const live = store.workspaces[conversationId];
  if (live) return live;
  return store.ensureWorkspace(conversationId);
}

/**
 * Applies a workspace mutation and publishes it: store first, then a
 * debounced IDB flush, then a preview rebuild. Returns the stored
 * state so callers can diff against it.
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
  // Trigger a debounced preview rebuild so the pane stays live
  schedulePreviewBuild(ws);
  const file = ws.files[path];
  const status = file?.status ?? "added";
  return {
    callId: "",
    name: "write_file",
    ok: true,
    data: {
      path,
      status,
      lines: content.split("\n").length,
      note: "File written to the workspace (not yet on GitHub). Preview is rebuilding.",
    },
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
    schedulePreviewBuild(result.ws);
    return {
      callId: "",
      name: "delete_file",
      ok: true,
      data: { path, status: "deleted", note: "File deleted in the workspace (not yet on GitHub)." },
      durationMs: Date.now() - started,
      summary: path,
    };
  }

  const result = deleteFile(ws, path);
  if (!result.ok) return fail(result.error ?? "Delete failed.");
  useChatStore.getState().setWorkspace(conversationId, result.ws);
  clearToolCache();
  schedulePreviewBuild(result.ws);
  return {
    callId: "",
    name: "delete_file",
    ok: true,
    data: { path, status: "deleted", note: "File deleted in the workspace (not yet on GitHub)." },
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
  schedulePreviewBuild(result.ws);

  const lines = outcome.content.split("\n").length;
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
      note: "Edit applied to the workspace (not yet on GitHub). Preview is rebuilding.",
    },
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

  // Persist fetched files: they are now readable by read_file and
  // bundled by the preview, so one search warms the whole session.
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
  schedulePreviewBuild(result.ws);

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
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
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
    if (preflight.canPush === false) {
      warnings.push({
        kind: "read-only-token",
        message:
          "This token cannot write to this repository — GitHub will reject the push (403). Use a fine-grained token with Contents: read and write.",
      });
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

  // The gap this closes: there is no shell here, so "all tests pass" can
  // only ever be an assertion. Comparing the summary against the change
  // set and the tools that actually ran turns that assertion into a
  // visible warning instead of a sentence a reviewer skims past.
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const toolsUsed = recentToolNames(conversation);
  const evidence = auditClaims({
    claim: lastAssistantClaim(conversation),
    changedPaths: changes.map((f) => f.path),
    toolsUsed,
  });
  warnings.push(...evidenceWarnings(evidence));

  // ── Open the gate: pause the agent loop until the user decides ──
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
    ...(warnings.length > 0 ? { warnings } : {}),
  });

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
  const openPr = decision.openPr ?? true;
  try {
    const result = await executePushChain(store.settings.github.token, {
      owner: ws.owner,
      repo: ws.repo,
      baseBranch: ws.branch,
      baseCommitSha: ws.baseCommitSha,
      commitMessage,
      prTitle,
      prBody: prBody ?? `Agent-generated changes pushed from InTab.\n\n${summarizeChanges(diffs)}`,
      files: changes.map((f) => ({ path: f.path, content: f.content, baseSha: f.baseSha })),
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
        prBody ?? `Agent-generated changes pushed from InTab.\n\n${summarizeChanges(diffs)}`
      );
      prUrl = pr.htmlUrl;
      prNumber = pr.number;
    }

    // Mark files as pushed and pin the new base
    const pushed = (await import("../workspace/workspace")).markPushed(ws, result.commitSha);
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
        files: changes.length,
        ...(evidence.length > 0
          ? {
              evidenceWarning:
                "The reviewer was told that part of your summary is not backed by the change set " +
                `${evidence.map((f) => f.message).join(" ")} Correct the record in your next message.`,
            }
          : {}),
      },
      durationMs: Date.now() - started,
      summary: prUrl ?? result.branchName,
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

// ── get_preview_feedback ─────────────────────────────────────

export async function runPreviewFeedback(
  conversationId: string,
  args: Record<string, unknown>,
  buildErrors: string[]
): Promise<ToolCallResult> {
  const started = Date.now();
  const preview = usePreviewStore.getState();

  const consoleIssues = preview.console
    .filter((e) => e.level === "error" || e.level === "warn")
    .slice(-15)
    .map((e) => `[${e.level}] ${e.text}`);

  const issues = [...buildErrors, ...consoleIssues];
  const data: Record<string, unknown> = {
    status: preview.status,
    entry: preview.entry,
    issueCount: issues.length,
    issues: issues.length > 0 ? issues : ["No errors — the preview built and is running cleanly."],
    runtimeReady: preview.runtimeReady,
  };

  return {
    callId: "",
    name: "get_preview_feedback",
    ok: true,
    data,
    durationMs: Date.now() - started,
    summary: issues.length > 0 ? `${issues.length} preview issue(s)` : "preview clean",
  };
}

// ── In-preview execution tools (agent verify loop) ───────────

/** Max in-preview executions per user turn (context + CPU guard) */
const PREVIEW_EXEC_PER_TURN = 5;
let previewExecCount = 0;
let previewExecTurn = "";

/** Called when the user sends a new message — resets the per-turn cap */
export function resetPreviewExecCounter(conversationId: string): void {
  if (previewExecTurn === conversationId) previewExecCount = 0;
}

function consumePreviewExecSlot(conversationId: string): string | null {
  if (previewExecTurn !== conversationId) {
    previewExecTurn = conversationId;
    previewExecCount = 0;
  }
  if (previewExecCount >= PREVIEW_EXEC_PER_TURN) {
    return `In-preview execution limit reached for this turn (${PREVIEW_EXEC_PER_TURN}). Summarize what you learned and continue; the limit resets on the user's next message.`;
  }
  previewExecCount++;
  return null;
}

/**
 * Ensures the preview reflects the CURRENT workspace before the
 * agent verifies against it: triggers a build when the workspace
 * changed after the last build and waits (bounded) for runtime.
 */
/** Bounded wait for an in-flight build to settle before failing the verify step */
const BUILD_SETTLE_TIMEOUT_MS = 10_000;

async function ensurePreviewFresh(): Promise<{ ok: boolean; error?: string }> {
  // A build in flight is not a failure — the tool may run right after
  // write_file while the debounced rebuild is still bundling. Wait
  // bounded for it to settle, then judge by the resulting status.
  if (usePreviewStore.getState().status === "building") {
    const deadline = Date.now() + BUILD_SETTLE_TIMEOUT_MS;
    while (usePreviewStore.getState().status === "building" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const pv = usePreviewStore.getState();
  if (pv.status !== "ready") {
    return { ok: false, error: "The preview has no successful build yet. Check get_preview_feedback for build errors first." };
  }
  if (!pv.runtimeReady) {
    // Give the fresh iframe a short window to report ready.
    const deadline = Date.now() + 3_000;
    while (!usePreviewStore.getState().runtimeReady && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!usePreviewStore.getState().runtimeReady) {
      return { ok: false, error: "The preview runtime is still starting — retry in a moment." };
    }
  }
  return { ok: true };
}

function previewToolResult(
  conversationId: string,
  name: "run_in_preview" | "query_preview_dom",
  started: number,
  outcome: { ok: boolean; result?: unknown; error?: string },
  summary: string
): ToolCallResult {
  return {
    callId: "",
    name,
    ok: outcome.ok,
    data: outcome.ok ? outcome.result : { error: outcome.error },
    durationMs: Date.now() - started,
    summary,
  };
}

/** run_in_preview — executes JS inside the built preview app */
export async function runInPreview(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const code = typeof args.code === "string" ? args.code : "";

  const capErr = consumePreviewExecSlot(conversationId);
  if (capErr) return previewToolResult(conversationId, "run_in_preview", started, { ok: false, error: capErr }, "limit reached");

  // Freshness: if files changed after the last build finished, the
  // iframe is stale — rebuild synchronously before executing.
  const pv = usePreviewStore.getState();
  if (pv.builtAt > 0 && wsChangedSince(pv.builtAt)) {
    const ws = useChatStore.getState().workspaces[conversationId];
    if (ws) await runPreviewBuild(ws);
  }
  const fresh = await ensurePreviewFresh();
  if (!fresh.ok) {
    return previewToolResult(conversationId, "run_in_preview", started, { ok: false, error: fresh.error }, "preview not ready");
  }

  const outcome = await runJsInPreview(code);
  return previewToolResult(
    conversationId,
    "run_in_preview",
    started,
    outcome,
    outcome.ok ? "preview eval" : "preview eval failed"
  );
}

/** query_preview_dom — reads rendered DOM from the preview */
export async function runQueryPreviewDom(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const selector = typeof args.selector === "string" ? args.selector : "";
  const mode = args.mode === "text" ? "text" : "html";

  const capErr = consumePreviewExecSlot(conversationId);
  if (capErr) return previewToolResult(conversationId, "query_preview_dom", started, { ok: false, error: capErr }, "limit reached");

  const pv = usePreviewStore.getState();
  if (pv.builtAt > 0 && wsChangedSince(pv.builtAt)) {
    const ws = useChatStore.getState().workspaces[conversationId];
    if (ws) await runPreviewBuild(ws);
  }
  const fresh = await ensurePreviewFresh();
  if (!fresh.ok) {
    return previewToolResult(conversationId, "query_preview_dom", started, { ok: false, error: fresh.error }, "preview not ready");
  }

  const outcome = await queryPreviewDom(selector, mode);
  return previewToolResult(
    conversationId,
    "query_preview_dom",
    started,
    outcome,
    outcome.ok ? selector : "dom query failed"
  );
}

/** True when the workspace changed after the given timestamp */
function wsChangedSince(ts: number): boolean {
  const convId = usePreviewStore.getState().conversationId;
  if (!convId) return false;
  const ws = useChatStore.getState().workspaces[convId];
  return Boolean(ws && ws.updatedAt > ts);
}

// ── Workspace management helpers (revert UI) ─────────────────

export async function revertWorkspaceFile(conversationId: string, path: string): Promise<void> {
  const ws = useChatStore.getState().workspaces[conversationId];
  if (!ws) return;
  const next = revertFile(ws, path);
  useChatStore.getState().setWorkspace(conversationId, next);
  schedulePreviewBuild(next);
}

export async function revertEntireWorkspace(conversationId: string): Promise<void> {
  const ws = useChatStore.getState().workspaces[conversationId];
  if (!ws) return;
  const next = revertAll(ws);
  useChatStore.getState().setWorkspace(conversationId, next);
  schedulePreviewBuild(next);
}

/**
 * Undoes the newest agent workspace mutation (effect log, LIFO) and
 * rebuilds the preview. One click = one step back in the agent's
 * edit history.
 */
export async function undoLastWorkspaceMutation(conversationId: string): Promise<void> {
  const ws = useChatStore.getState().workspaces[conversationId];
  if (!ws) return;
  const next = undoLast(ws);
  useChatStore.getState().setWorkspace(conversationId, next);
  schedulePreviewBuild(next);
}
