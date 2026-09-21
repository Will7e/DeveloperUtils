// ============================================================
// Tool Call Block — Agent Activity Rows in the Transcript
// ============================================================
// Renders one assistant tool-calls message with its paired results:
// a compact header ("used 3 tools") and one collapsible row per
// call (icon, name, target, duration, ok/error). Expanding a row
// shows a truncated result preview. User messages with toolResult
// payloads never render as bubbles — they pair up here instead.

import React from "react";
import {
  ChevronDown,
  CircleAlert,
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
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { ChatMessage, ToolName } from "../types";

function toolIcon(name: ToolName): React.ComponentType<{ className?: string }> {
  switch (name) {
    case "list_repo_files":
      return FolderTree;
    case "read_file":
      return FileText;
    case "search_code":
      return Search;
    case "get_repo_overview":
      return ListTree;
    case "write_file":
      return FilePen;
    case "delete_file":
      return FileMinus2;
    case "create_working_branch":
      return GitBranch;
    case "push_changes":
      return GitPullRequest;
    case "get_preview_feedback":
      return MonitorPlay;
    default:
      return Info;
  }
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

  return (
    <div className="chat-tool-block" role="group" aria-label="Agent tool activity">
      <div className="chat-tool-block-header">
        <span className="chat-tool-block-title">
          {streamingResults
            ? "Working with the repository…"
            : `Used ${calls.length} tool${calls.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {calls.map((call) => {
        const result = results.get(call.id);
        const resultMsg = result?.toolResult;
        const pending = !resultMsg;
        const ok = resultMsg?.ok ?? false;
        const Icon = toolIcon(call.name);
        const isOpen = openRows.has(call.id);

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

        return (
          <div key={call.id} className={`chat-tool-row ${isOpen ? "chat-tool-row-open" : ""}`}>
            <button
              type="button"
              className="chat-tool-row-header"
              onClick={() => toggleRow(call.id)}
              aria-expanded={isOpen}
            >
              {pending ? (
                <Loader2 className="h-3 w-3 chat-tool-icon chat-tool-pending" aria-hidden="true" />
              ) : ok ? (
                <Icon className="h-3 w-3 chat-tool-icon" aria-hidden="true" />
              ) : (
                <CircleAlert className="h-3 w-3 chat-tool-icon chat-tool-error" aria-hidden="true" />
              )}
              <span className="chat-tool-name">{call.name}</span>
              {target && <span className="chat-tool-target" title={target}>{target}</span>}
              {resultMsg && (
                <span className="chat-tool-duration">{resultMsg.durationMs}ms</span>
              )}
              <ChevronDown className="h-3 w-3 chat-tool-chevron" aria-hidden="true" />
            </button>
            {isOpen && (
              <div className="chat-tool-body">
                {resultMsg ? (
                  <pre className="chat-tool-result">
                    {resultMsg.content.length > 1_200
                      ? `${resultMsg.content.slice(0, 1_200)}\n…[preview truncated]`
                      : resultMsg.content}
                  </pre>
                ) : (
                  <div className="chat-tool-note">Waiting for result…</div>
                )}
              </div>
            )}
          </div>
        );
      })}
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
