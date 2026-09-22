// ============================================================
// Tool Call Block — The Agent's Chain of Actions
// ============================================================
// Renders one assistant tool-calls message with its paired results as
// a NUMBERED chain of steps rather than a heap of "used 5 tools" rows:
// each step shows what the agent did (verb + target), what changed
// (+additions/−deletions, replacements, file status) and how long it
// took. A failed step carries its own error text inline, so a stopped
// chain can be read without expanding anything.
//
// Expanding a row still reveals the raw result payload. User messages
// with toolResult payloads never render as bubbles — they pair up here.

import React from "react";
import {
  Bot,
  Brain,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  FileDiff,
  FileMinus2,
  FilePen,
  FileText,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Info,
  ListTree,
  Loader2,
  MonitorPlay,
  Plug,
  ScanEye,
  Search,
  SquareArrowOutUpRight,
  Terminal,
} from "lucide-react";
import { DiffView } from "./DiffView";
import { MarkdownContent } from "./markdown";
import {
  readToolResultPayload,
  summarizeToolStep,
  sumStepChanges,
} from "../lib/tool-step-summary";
import type { ChatMessage, ToolName } from "../types";

function toolIcon(name: ToolName): React.ComponentType<{ className?: string }> {
  switch (name) {
    case "list_repo_files":
      return FolderTree;
    case "read_file":
      return FileText;
    case "search_code":
    case "search_workspace":
      return Search;
    case "get_repo_overview":
      return ListTree;
    case "write_file":
      return FilePen;
    case "edit_file":
      return FileDiff;
    case "delete_file":
      return FileMinus2;
    case "get_workspace_diff":
      return FileDiff;
    case "run_checks":
      return CheckCheck;
    case "create_working_branch":
      return GitBranch;
    case "push_changes":
      return GitPullRequest;
    case "get_preview_feedback":
      return MonitorPlay;
    case "run_in_preview":
      return Terminal;
    case "query_preview_dom":
    case "check_preview_visually":
    case "get_preview_layout":
      return ScanEye;
    case "delegate":
      return Bot;
    case "remember":
      return Brain;
    case "list_mcp_tools":
    case "call_mcp_tool":
      return Plug;
    default:
      return Info;
  }
}

/** Human verb for a step, in the past tense the transcript reads in */
function toolVerb(name: ToolName): string {
  switch (name) {
    case "list_repo_files":
      return "Listed files";
    case "read_file":
      return "Read";
    case "search_code":
      return "Searched repo";
    case "search_workspace":
      return "Searched working copy";
    case "get_repo_overview":
      return "Surveyed repo";
    case "write_file":
      return "Wrote";
    case "edit_file":
      return "Edited";
    case "delete_file":
      return "Deleted";
    case "get_workspace_diff":
      return "Reviewed diff";
    case "run_checks":
      return "Ran checks";
    case "create_working_branch":
      return "Created branch";
    case "push_changes":
      return "Pushed";
    case "get_preview_feedback":
      return "Read preview console";
    case "run_in_preview":
      return "Ran in preview";
    case "query_preview_dom":
      return "Inspected DOM";
    case "check_preview_visually":
      return "Looked at preview";
    case "get_preview_layout":
      return "Measured layout";
    case "delegate":
      return "Delegated";
    case "remember":
      return "Remembered";
    case "run_tool_program":
      return "Ran tool program";
    case "list_mcp_tools":
      return "Listed MCP tools";
    case "call_mcp_tool":
      return "Called MCP tool";
    default:
      return name;
  }
}

function formatDuration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
}

/** Keeps one expanded row from dumping an entire tool result into the DOM */
function truncate(content: string): string {
  return content.length > 1_200 ? `${content.slice(0, 1_200)}\n…[preview truncated]` : content;
}

interface ToolCallBlockProps {
  /** The assistant tool-calls message */
  message: ChatMessage;
  /** All conversation messages — used to find paired results */
  allMessages: ChatMessage[];
}

export const ToolCallBlock = React.memo(function ToolCallBlock({
  message,
  allMessages,
}: ToolCallBlockProps) {
  const [openRows, setOpenRows] = React.useState<Set<string>>(new Set());
  const calls = message.toolCalls?.calls ?? [];

  // Results are the toolResult messages that follow this message in order
  const results = React.useMemo(() => {
    const idx = allMessages.findIndex((m) => m.id === message.id);
    const out = new Map<string, ChatMessage>();
    for (let i = idx + 1; i < allMessages.length; i++) {
      const m = allMessages[i];
      if (!m) break;
      if (m.toolCalls) break; // next agent turn — stop pairing
      if (m.toolResult) out.set(m.toolResult.callId, m);
    }
    return out;
  }, [allMessages, message.id]);

  const toggleRow = (callId: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };

  const streamingResults = results.size < calls.length;
  // The model usually narrates what it is about to do alongside the
  // calls. That prose used to be dropped by the transcript's early
  // return, which left the turn reading as thinking + anonymous rows.
  const narration = (message.content ?? "").trim();

  const steps = calls.map((call) => {
    const resultMsg = results.get(call.id)?.toolResult;
    const payload = readToolResultPayload(resultMsg?.content);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      /* defensive — executor tolerates junk too */
    }
    const target =
      (typeof args.path === "string" && args.path) ||
      (typeof args.query === "string" && `"${args.query}"`) ||
      (typeof args.subtree === "string" && `${args.subtree}/`) ||
      "";
    const unknownCall = call;
    return {
      call: unknownCall,
      resultMsg,
      payload,
      target,
      stats: summarizeToolStep(payload),
      pending: !resultMsg,
      ok: resultMsg?.ok ?? false,
    };
  });

  const totals = sumStepChanges(steps.map((step) => step.stats));
  const failed = steps.filter((s) => s.resultMsg && !s.ok).length;

  return (
    <div className="chat-tool-block" role="group" aria-label="Agent tool activity">
      {narration.length > 0 && (
        <MarkdownContent content={narration} className="chat-tool-narration chat-md" />
      )}
      <div className="chat-tool-block-header">
        <span className="chat-tool-block-title">
          {streamingResults
            ? `Working — step ${Math.min(steps.length, results.size + 1)} of ${steps.length}`
            : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
        </span>
        {(totals.additions > 0 || totals.deletions > 0) && (
          <span className="chat-tool-block-totals" title="Lines changed in the working copy">
            {totals.additions > 0 && (
              <span className="chat-tool-stat-add">+{totals.additions}</span>
            )}
            {totals.deletions > 0 && (
              <span className="chat-tool-stat-del">−{totals.deletions}</span>
            )}
          </span>
        )}
        {failed > 0 && (
          <span className="chat-tool-block-failed">
            {failed} failed
          </span>
        )}
      </div>
      <ol className="chat-tool-steps">
        {steps.map((step, index) => {
          const { call, resultMsg, stats, target, pending, ok } = step;
          const Icon = toolIcon(call.name);
          const isOpen = openRows.has(call.id);
          const verb = pending ? `${toolVerb(call.name)}…` : toolVerb(call.name);
          const errorFact = !ok && !pending ? stats.facts[stats.facts.length - 1] : null;

          return (
            <li
              key={call.id}
              className={`chat-tool-row ${isOpen ? "chat-tool-row-open" : ""}`}
            >
              <button
                type="button"
                className="chat-tool-row-header"
                onClick={() => toggleRow(call.id)}
                aria-expanded={isOpen}
              >
                <span className="chat-tool-step-index" aria-hidden="true">
                  {index + 1}
                </span>
                {pending ? (
                  <Loader2
                    className="h-3 w-3 chat-tool-icon chat-tool-pending"
                    aria-hidden="true"
                  />
                ) : ok ? (
                  <Icon className="h-3 w-3 chat-tool-icon" aria-hidden="true" />
                ) : (
                  <CircleAlert
                    className="h-3 w-3 chat-tool-icon chat-tool-error"
                    aria-hidden="true"
                  />
                )}
                <span className="chat-tool-name">{verb}</span>
                {target && (
                  <span className="chat-tool-target" title={target}>
                    {target}
                  </span>
                )}
                {!errorFact &&
                  stats.facts.map((fact) => (
                    <span key={fact} className="chat-tool-detail">
                      {fact}
                    </span>
                  ))}
                {stats.additions > 0 && (
                  <span className="chat-tool-stat-add">+{stats.additions}</span>
                )}
                {stats.deletions > 0 && (
                  <span className="chat-tool-stat-del">−{stats.deletions}</span>
                )}
                {errorFact && (
                  <span className="chat-tool-detail-error" title={errorFact}>
                    {errorFact}
                  </span>
                )}
                {resultMsg && (
                  <span className="chat-tool-duration">{formatDuration(resultMsg.durationMs)}</span>
                )}
                <ChevronDown className="h-3 w-3 chat-tool-chevron" aria-hidden="true" />
              </button>
              {isOpen && (
                <div className="chat-tool-body">
                  {!resultMsg ? (
                    <div className="chat-tool-note">Waiting for result…</div>
                  ) : resultMsg.change ? (
                    // A mutation step opens into the code it wrote — the
                    // question a step row should answer is "what changed?",
                    // not "what did the tool reply?".
                    <>
                      <div className="chat-tool-diff-head">
                        <span className="chat-tool-diff-path" title={resultMsg.change.path}>
                          {resultMsg.change.path}
                        </span>
                        <span className="chat-tool-diff-stats">
                          {resultMsg.change.status !== "modified" && (
                            <span className="chat-tool-detail">{resultMsg.change.status}</span>
                          )}
                          {resultMsg.change.additions > 0 && (
                            <span className="chat-tool-stat-add">
                              +{resultMsg.change.additions}
                            </span>
                          )}
                          {resultMsg.change.deletions > 0 && (
                            <span className="chat-tool-stat-del">
                              −{resultMsg.change.deletions}
                            </span>
                          )}
                        </span>
                      </div>
                      <DiffView
                        patch={resultMsg.change.patch}
                        className="chat-tool-diff"
                        maxHeight="40vh"
                      />
                      {resultMsg.change.truncated && (
                        <div className="chat-tool-note">
                          Diff truncated — the Changes pane has the full patch.
                        </div>
                      )}
                      <details className="chat-tool-raw">
                        <summary>Tool result</summary>
                        <pre className="chat-tool-result">{truncate(resultMsg.content)}</pre>
                      </details>
                    </>
                  ) : (
                    <pre className="chat-tool-result">{truncate(resultMsg.content)}</pre>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
});

/** Renders a repo link chip used inside result previews */
export function RepoFileLink({ owner, repo, path, branch }: { owner: string; repo: string; path: string; branch: string }) {
  return (
    <a
      className="chat-tool-file-link"
      href={`https://github.com/${owner}/${repo}/blob/${branch}/${path}`}
      target="_blank"
      rel="noreferrer"
    >
      <SquareArrowOutUpRight className="h-3 w-3" />
      {path}
    </a>
  );
}
