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
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  ClipboardCopy,
  Clock,
  FileDiff,
  FileMinus2,
  FilePen,
  FilePlus2,
  Loader2,
  MonitorPlay,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { selectStream, selectWorkspace, useChatStore } from "@/stores/chat.store";
import { collectChangeSet } from "../lib/change-set";
import { failingPaths } from "../lib/change-set-verification";
import {
  planVerification,
  representativeEvidence,
  verificationLabel,
  verificationState,
} from "../lib/verification-plan";
import {
  formatAge,
  verificationEvent,
  type VerificationEvidence,
} from "../lib/verification-ledger";
import { repoKeyOf } from "../container/preview-bridge";
import { runRunChecks, undoLastWorkspaceMutation } from "../services/agent-actions";
import { DiffView } from "./DiffView";
import { VerificationCard } from "./VerificationCard";
import { useVerificationReadout } from "./useVerificationReadout";
import { WorkspacePreview } from "./WorkspacePreview";
import type { ToolCallResult, WorkspaceChange } from "../types";

/** The two surfaces the workspace panel holds, and which one is showing */
export type WorkspacePanelTab = "changes" | "preview";

interface ChangesPaneProps {
  conversationId: string | null;
  onClose: () => void;
  /**
   * Which surface the workspace panel is showing — the diff (default) or the
   * live preview. Owned by the page so the workspace strip, the composer-level
   * row, can move the panel between them.
   */
  tab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  /**
   * True when this pane is the whole surface — the ≤860px sheet, which covers the
   * chat header. Only then does the pane state the verification word itself; in
   * the split layout the header chip is on screen saying the same sentence (see
   * VerificationControls below).
   */
  standalone?: boolean;
}

/**
 * Verification in the pane: the state word, and the one action here that
 * produces evidence instead of showing it.
 *
 * WHY THE WORD IS OPTIONAL. This badge and the header chip read the same
 * derivation (lib/verification-plan) over the same ledger read, so they render
 * the same sentence — and in the split layout both are on screen at once, a
 * header apart. Two surfaces repeating one word does not make it more true; it
 * makes the loudest thing in the chrome say nothing the reader has not already
 * read. The pane is the one that yields, because the chip is visible in every
 * layout and every pane state while the pane exists only while it is open.
 *
 * So the pane states the word exactly when it is the whole surface
 * (`standalone` — the ≤860px sheet, which covers the header), and otherwise puts
 * the state on the button, where it belongs to the action: "Run checks" before
 * anything has run, "Re-run checks" once something has, with the word, the tier
 * and the age in the title.
 *
 * What the pane never gives up is the part the header cannot show — the per-file
 * failure markers below, which are the only per-file claim the ledger supports.
 */
function VerificationControls({
  evidence,
  workspaceUpdatedAt,
  repoAttached,
  hasChanges,
  pushed,
  loading,
  canRun,
  showState,
  onRun,
}: {
  evidence: readonly VerificationEvidence[];
  workspaceUpdatedAt: number | undefined;
  repoAttached: boolean;
  hasChanges: boolean;
  pushed: boolean;
  loading: boolean;
  canRun: boolean;
  /** Whether to draw the state word — see the note above */
  showState: boolean;
  onRun: () => void;
}) {
  const state = verificationState(evidence);
  const entry = representativeEvidence(evidence);
  const label = verificationLabel(evidence);
  const ran = state !== "none";
  const plan = React.useMemo(
    () =>
      planVerification({ repoAttached, hasChanges, pushed, evidence }),
    [repoAttached, hasChanges, pushed, evidence]
  );

  const Icon =
    state === "fail" ? AlertTriangle : state === "pass" ? Check : state === "stale" ? Clock : CircleDashed;

  // The state, in the words the chip and the push gate use, plus the age of the
  // run being spoken about. Reads as "Checks failed · 2 min ago — run the …".
  const runTitle = canRun
    ? ran
      ? `${label}${entry ? ` · ${formatAge(entry.ageMs)}` : ""} — run the in-browser type check again`
      : "Run the in-browser type check over this workspace"
    : "Nothing to check until the agent changes a file";

  return (
    <span className="chat-changes-verify">
      {showState && (
        <SimpleTooltip
          side="bottom"
          className="chat-verify-card"
          content={<VerificationCard state={state} evidence={evidence} plan={plan} />}
        >
          <span
            className={`chat-changes-verify-badge chat-changes-verify-${state}`}
            tabIndex={0}
            role="status"
            aria-label={`${label} — ${
              workspaceUpdatedAt === undefined
                ? "no workspace revision to judge against"
                : "focus for what has been proven"
            }`}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            <span className="chat-changes-verify-label">{label}</span>
            {entry && <span className="chat-changes-verify-age">{formatAge(entry.ageMs)}</span>}
          </span>
        </SimpleTooltip>
      )}
      {/* The one action in this pane that produces evidence instead of just
          showing it. It is the same executor the agent's `run_checks` uses, so
          a user-triggered run lands in the same ledger the push gate reads. */}
      <button
        type="button"
        className="chat-changes-run"
        onClick={onRun}
        disabled={!canRun || loading}
        title={runTitle}
        /* The visible word leads, so voice control can reach the button by the
           label it can see; the state rides after it. */
        aria-label={ran ? `Re-run checks: ${label}` : "Run checks"}
      >
        {loading ? (
          <Loader2 className="h-3 w-3 spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        )}
        {loading ? "Checking…" : ran ? "Re-run checks" : "Run checks"}
      </button>
    </span>
  );
}

export const ChangesPane = React.memo(function ChangesPane({
  conversationId,
  onClose,
  tab,
  onTabChange,
  standalone = false,
}: ChangesPaneProps) {
  // Fail closed: right after a repository switch the in-memory entry is the
  // previous repository's, and showing its change set under the new
  // repository's name is how a diff of the wrong code gets reviewed.
  const workspace = useChatStore((s) => selectWorkspace(s, conversationId) ?? undefined);
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId));
  const repoAttached = Boolean(conversation?.repoContext);
  // The preview tab's header label: whose session the panel is showing. Derived
  // from THIS conversation's repo context, the same way the page derives it.
  const repoKey = repoKeyOf(conversation?.repoContext?.owner, conversation?.repoContext?.repo);
  // THIS thread's stream, not "the" one: a peer agent editing its own working
  // copy in another chat must not grey out this pane's Run-checks button.
  const isStreamingHere = useChatStore((s) => selectStream(s, conversationId) !== null);

  const changes = React.useMemo(() => collectChangeSet(workspace), [workspace]);
  const [openPaths, setOpenPaths] = React.useState<Set<string>>(new Set());
  const [copied, setCopied] = React.useState(false);
  const [runningChecks, setRunningChecks] = React.useState(false);

  // What has been proven about THIS revision, through the one shared read
  // (components/useVerificationReadout.ts) that the header chip and the activity
  // rail also use — freshness is the ledger's rule, never a local comparison.
  const { evidence, workspaceUpdatedAt } = useVerificationReadout(conversationId);

  // A stale failure names files that no longer contain the mistake, so only
  // fresh ones mark a row.
  const failing = React.useMemo(() => failingPaths(evidence), [evidence]);

  const canUndo = Boolean(workspace?.mutations?.length);
  const allOpen = changes.fileCount > 0 && openPaths.size >= changes.fileCount;

  /**
   * Runs the workspace type check the way the agent's `run_checks` does.
   *
   * Deliberately the SAME executor (services/agent-actions) rather than a second
   * implementation: the result lands in the ledger the push gate reads, so a
   * check the user ran is evidence the agent can cite and the approval dialog
   * will show. No transcript row is written — this is the user's action, not the
   * agent's, and the ledger is its record.
   */
  const runChecks = () => {
    if (!conversationId || runningChecks) return;
    setRunningChecks(true);
    // Also published to the store: a type check over a large workspace runs for
    // tens of seconds, and the activity rail above the composer must not claim
    // the agent is idle while it does.
    useChatStore.getState().setCheckRun(conversationId, true);
    void runRunChecks(conversationId, { run: true })
      .then((result: ToolCallResult) => {
        // The recorded entry is the fact; the tool payload is the narrative
        // around it. Reading the ledger back means the toast cannot disagree
        // with the badge beside it.
        const entry = verificationEvent(conversationId, "typecheck");
        if (entry) {
          useAppStore.getState().addToast({
            message: entry.ok
              ? `Type check passed — ${entry.summary}.`
              : `Type check found errors — ${entry.summary}. Fix them, then run it again.`,
            type: entry.ok ? "info" : "error",
            duration: entry.ok ? 4000 : 7000,
          });
          return;
        }
        // Nothing was recorded, so nothing ran. The reason is the point: an
        // "everything is fine" toast here would be the exact false pass the
        // ledger refuses to record.
        const local = firstLocalCheck(result);
        useAppStore.getState().addToast({
          message:
            local?.unavailable ??
            "The type check could not run in this workspace, so nothing was proven.",
          type: "error",
          duration: 7000,
        });
      })
      .catch(() => {
        useAppStore.getState().addToast({
          message: "The type check could not run — nothing was proven.",
          type: "error",
          duration: 6000,
        });
      })
      .finally(() => {
        setRunningChecks(false);
        if (conversationId) useChatStore.getState().setCheckRun(conversationId, false);
      });
  };

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
        {/* The panel's two surfaces as tabs: the diff, and the app running.
            Same row as the title so the switch is one glance, not a hunt. */}
        <div className="chat-panel-tabs" role="tablist" aria-label="Workspace panel">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "changes"}
            className={`chat-panel-tab ${tab === "changes" ? "chat-panel-tab-active" : ""}`}
            onClick={() => onTabChange("changes")}
          >
            <FileDiff className="h-3.5 w-3.5" aria-hidden="true" />
            Changes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={`chat-panel-tab ${tab === "preview" ? "chat-panel-tab-active" : ""}`}
            onClick={() => onTabChange("preview")}
          >
            <MonitorPlay className="h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </button>
        </div>
        {tab === "changes" && changes.fileCount > 0 && (
          <span className="chat-changes-stats">
            {changes.fileCount} file{changes.fileCount === 1 ? "" : "s"} ·{" "}
            <span className="chat-changes-add">+{changes.additions}</span>{" "}
            <span className="chat-changes-del">−{changes.deletions}</span>
          </span>
        )}
        {/* Verification rides with the diff, not just in the header: the moment
            a reviewer needs it is the moment they are reading this pane. The
            state word is drawn only when nothing else on screen is saying it. */}
        {tab === "changes" && repoAttached && (
          <VerificationControls
            evidence={evidence}
            workspaceUpdatedAt={workspaceUpdatedAt}
            repoAttached={repoAttached}
            hasChanges={!changes.empty}
            pushed={Boolean(workspace?.pushedAt)}
            loading={runningChecks}
            canRun={!changes.empty && !isStreamingHere}
            showState={standalone}
            onRun={runChecks}
          />
        )}
        {/* The close button serves the whole panel — on the preview tab it is
            the panel's only exit — so it stays outside the tab condition. */}
        <div className="chat-changes-actions">
          {tab === "changes" && changes.fileCount > 0 && (
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

      {tab === "preview" ? (
        <WorkspacePreview repoKey={repoKey} />
      ) : (
      <div className="chat-changes-body">
        {changes.empty ? (
          <div className="chat-changes-empty">
            <FileDiff className="h-5 w-5" aria-hidden="true" />
            <p>
              {repoAttached
                ? "No changes yet. Every file the agent edits shows up here with its diff — the same change set push_changes will ship. Run checks once it has, and this pane says what has actually been proven about the revision you are reading."
                : "Attach a repository from the chat header to give the agent code to change."}
            </p>
          </div>
        ) : (
          <ul className="chat-changes-list">
            {changes.files.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                failing={failing.has(change.path)}
                open={openPaths.has(change.path)}
                onToggle={() => toggle(change.path)}
              />
            ))}
          </ul>
        )}
      </div>
      )}

      {tab === "changes" && !changes.empty && (
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

/**
 * The local-check entry in a `run_checks` payload, when there is one.
 *
 * Typed defensively because `data` is `unknown` by design (it is the model's
 * payload, not this component's contract): the only field read is `unavailable`,
 * which is the sentence to show when NOTHING ran. Everything else is answered
 * from the ledger, so a payload shape change can cost a sentence, never a false
 * "passed".
 */
function firstLocalCheck(result: ToolCallResult): { unavailable?: string } | null {
  const data = result.data;
  if (!data || typeof data !== "object") return null;
  const local = (data as { localChecks?: unknown }).localChecks;
  if (!Array.isArray(local) || local.length === 0) return null;
  const first = local[0];
  if (!first || typeof first !== "object") return null;
  const unavailable = (first as { unavailable?: unknown }).unavailable;
  return typeof unavailable === "string" ? { unavailable } : null;
}

const STATUS_ICON = {
  added: FilePlus2,
  deleted: FileMinus2,
  modified: FilePen,
} as const;

function ChangeRow({
  change,
  failing,
  open,
  onToggle,
}: {
  change: WorkspaceChange;
  /** A fresh check failure names this file — the only per-file claim allowed */
  failing: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = STATUS_ICON[change.status === "unchanged" ? "modified" : change.status];

  return (
    <li
      className={`chat-changes-row ${open ? "chat-changes-row-open" : ""} ${
        failing ? "chat-changes-row-failing" : ""
      }`}
    >
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
        {/* Only failures are marked per file. A passing suite says nothing about
            which files it exercised, so a green tick here would be invented. */}
        {failing && (
          <AlertTriangle
            className="h-3.5 w-3.5 chat-changes-row-fail-icon"
            aria-label="A check failed on this file"
          />
        )}
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
