// ============================================================
// ChangesPane — What the Agent Actually Changed
// ============================================================
// The right-hand panel's default view: every file the agent has
// edited in this conversation's workspace, in path order, each with
// its unified diff, and the totals for the change set as a whole.
//
// Approving a push (and trusting an agent at all) means seeing which
// files moved and how, which is a diff. It is deliberately the same
// change set the push gate shows, diffed by the same function, so
// what you read here is what ships.
//
// Edits appear as they land: the pane reads the workspace store, and
// every agent write publishes a new snapshot.

import React from "react";
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  FileDiff,
  FileMinus2,
  FilePen,
  FilePlus2,
  Undo2,
  X,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import { collectChangeSet } from "../lib/change-set";
import { undoLastWorkspaceMutation } from "../services/agent-actions";
import { DiffView } from "./DiffView";
import type { WorkspaceChange } from "../types";

interface ChangesPaneProps {
  conversationId: string | null;
  onClose: () => void;
}

export const ChangesPane = React.memo(function ChangesPane({
  conversationId,
  onClose,
}: ChangesPaneProps) {
  // Fail closed: right after a repository switch the in-memory entry is the
  // previous repository's, and showing its change set under the new
  // repository's name is how a diff of the wrong code gets reviewed.
  const workspace = useChatStore((s) => selectWorkspace(s, conversationId) ?? undefined);
  const repoAttached = useChatStore((s) =>
    Boolean(s.conversations.find((c) => c.id === conversationId)?.repoContext)
  );

  const changes = React.useMemo(() => collectChangeSet(workspace), [workspace]);
  const [openPaths, setOpenPaths] = React.useState<Set<string>>(new Set());
  const [copied, setCopied] = React.useState(false);

  const canUndo = Boolean(workspace?.mutations?.length);
  const allOpen = changes.fileCount > 0 && openPaths.size >= changes.fileCount;

  const toggle = (path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const copyPatch = () => {
    const patch = changes.files.map((f) => `${f.patch}\n`).join("\n");
    void navigator.clipboard
      ?.writeText(patch)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        useAppStore.getState().addToast({
          message: "Could not copy the diff to the clipboard.",
          type: "error",
        });
      });
  };

  return (
    <div className="chat-changes" role="region" aria-label="Agent code changes">
      <div className="chat-changes-header">
        <span className="chat-changes-title">
          <FileDiff className="h-3.5 w-3.5" aria-hidden="true" />
          Changes
        </span>
        {changes.fileCount > 0 && (
          <span className="chat-changes-stats">
            {changes.fileCount} file{changes.fileCount === 1 ? "" : "s"} ·{" "}
            <span className="chat-changes-add">+{changes.additions}</span>{" "}
            <span className="chat-changes-del">−{changes.deletions}</span>
          </span>
        )}
        <div className="chat-changes-actions">
          {changes.fileCount > 0 && (
            <>
              <button
                type="button"
                className="toolbar-icon-btn"
                onClick={() => setOpenPaths(allOpen ? new Set() : new Set(changes.files.map((f) => f.path)))}
                title={allOpen ? "Collapse all diffs" : "Expand all diffs"}
                aria-label={allOpen ? "Collapse all diffs" : "Expand all diffs"}
              >
                <ChevronDown className={`h-3.5 w-3.5 ${allOpen ? "chat-changes-chevron-open" : ""}`} />
              </button>
              <button
                type="button"
                className="toolbar-icon-btn"
                onClick={copyPatch}
                title="Copy the whole diff"
                aria-label="Copy the whole diff"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
              </button>
            </>
          )}
          <button
            type="button"
            className="toolbar-icon-btn"
            onClick={() => {
              if (conversationId) void undoLastWorkspaceMutation(conversationId);
            }}
            disabled={!canUndo}
            title={canUndo ? "Undo the last agent edit" : "No agent edits to undo"}
            aria-label="Undo the last agent edit"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="toolbar-icon-btn"
            onClick={onClose}
            title="Close changes"
            aria-label="Close changes"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="chat-changes-body">
        {changes.empty ? (
          <div className="chat-changes-empty">
            <FileDiff className="h-5 w-5" aria-hidden="true" />
            <p>
              {repoAttached
                ? "No changes yet. Every file the agent edits shows up here with its diff — the same change set push_changes will ship."
                : "Attach a repository from the chat header to give the agent code to change."}
            </p>
          </div>
        ) : (
          <ul className="chat-changes-list">
            {changes.files.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                open={openPaths.has(change.path)}
                onToggle={() => toggle(change.path)}
              />
            ))}
          </ul>
        )}
      </div>

      {!changes.empty && (
        <div className="chat-changes-footer">
          <span className="chat-changes-note">
            Diff of the workspace — nothing reaches {workspace ? `${workspace.owner}/${workspace.repo}` : "GitHub"} until
            you approve a push.
          </span>
        </div>
      )}
    </div>
  );
});

const STATUS_ICON = {
  added: FilePlus2,
  deleted: FileMinus2,
  modified: FilePen,
} as const;

function ChangeRow({
  change,
  open,
  onToggle,
}: {
  change: WorkspaceChange;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = STATUS_ICON[change.status === "unchanged" ? "modified" : change.status];

  return (
    <li className={`chat-changes-row ${open ? "chat-changes-row-open" : ""}`}>
      <button
        type="button"
        className="chat-changes-row-header"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Icon className={`h-3.5 w-3.5 chat-changes-icon-${change.status}`} aria-hidden="true" />
        <span className="chat-changes-path" title={change.path}>
          {change.path}
        </span>
        <span className="chat-changes-row-stats">
          {change.additions > 0 && <span className="chat-changes-add">+{change.additions}</span>}
          {change.deletions > 0 && <span className="chat-changes-del">−{change.deletions}</span>}
        </span>
        <ChevronDown className="h-3 w-3 chat-changes-chevron" aria-hidden="true" />
      </button>
      {open && <DiffView patch={change.patch} />}
    </li>
  );
}
