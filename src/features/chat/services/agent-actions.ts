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
import { undoLast } from "../workspace/undo";
import { clearToolCache } from "../lib/tool-cache";
import {
  executePushChain,
  isProtectedBranchName,
  uniqueBranchName,
  GitHubWriteError,
} from "../lib/github-write";
import { schedulePreviewBuild, runPreviewBuild } from "../preview/preview-runtime";
import { runJsInPreview, queryPreviewDom } from "../preview/preview-bridge";
import { usePreviewStore } from "../preview/preview.store";
import type { ToolCallResult } from "../types";

// ── write_file ───────────────────────────────────────────────

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

  const store = useChatStore.getState();
  const ws = await store.ensureWorkspace(conversationId);
  if (!ws) {
    return fail("No workspace available — attach a repository with a write-capable token first.");
  }

  // Modifying an existing repo file requires loading it first
  if (!ws.files[path] && ws.tree.some((e) => e.path === path && e.type === "blob")) {
    const loaded = await readFile(ws, store.settings.github.token, path);
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

  const store = useChatStore.getState();
  const ws = await store.ensureWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  // Load before delete so the tombstone has base content for diffs
  if (!ws.files[path] && ws.tree.some((e) => e.path === path && e.type === "blob")) {
    const loaded = await readFile(ws, store.settings.github.token, path);
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
  const ws = await store.ensureWorkspace(conversationId);
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
  const ws = await store.ensureWorkspace(conversationId);
  if (!ws) return fail("No workspace available — attach a repository first.");

  const changes: PushFile[] = collectChanges(ws);
  if (changes.length === 0) {
    return fail("No workspace changes to push — edit files with write_file first.");
  }
  if (store.pendingPush) {
    return fail("A push is already awaiting approval — wait for the user to decide.");
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
  const openPr = (window as unknown as { __intabPrApproved?: boolean }).__intabPrApproved ?? true;
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
  const wantsScreenshot = args.screenshot === true;

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
  if (wantsScreenshot && preview.screenshot) {
    data.screenshot = "(screenshot captured — see the preview pane)";
  }

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
