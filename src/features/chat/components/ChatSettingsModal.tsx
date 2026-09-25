// ============================================================
// Chat Settings Modal — OpenRouter Key, Model, Prompt, Data, Skills
// ============================================================
// Built on the app's shared .settings-* layout vocabulary so it
// visually matches the main SettingsPanel. Uses the same pill-style
// tab bar, flat section layout, input/select/toggle tokens, and
// footer pattern.

import React from "react";
import {
  AlertTriangle,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  Key,
  Loader2,
  MessageSquare,
  MessageSquareText,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { checkKey, type KeyCheckResult } from "../lib/openrouter-client";
import { OPENROUTER_CONSOLE_URL } from "../constants";
import { connectViaOAuth, connectWithToken } from "../services/github-auth";
import { invalidateRepoCache } from "../lib/github-client";
import {
  downloadSkillFile,
  parseSkillFile,
  skillFromParsed,
} from "../lib/skills";
import { activeServers, parseMcpServersJson, serializeMcpServers } from "../lib/mcp";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker } from "./EffortPicker";
import { availableEfforts } from "../lib/model-state";
import { resolveModelInfo } from "../lib/model-catalog";
import type { ChatSettings, ChatSkill, GitHubConnectionState, ModelInfo } from "../types";

interface ChatSettingsModalProps {
  open: boolean;
  settings: ChatSettings;
  conversationCount: number;
  /** Model catalog for the default-model picker */
  models: ModelInfo[];
  /** Tab to focus on open (from store deep-links) */
  initialTab?: "connection" | "chat" | "skills" | "github" | null;
  onClose: () => void;
  onUpdate: (patch: Partial<ChatSettings>) => void;
  onClearAllConversations: () => void;
  onAddSkill: (skill: ChatSkill) => void;
  onUpdateSkill: (id: string, patch: Partial<Omit<ChatSkill, "id" | "builtin">>) => void;
  onDeleteSkill: (id: string) => void;
  onResetBuiltinSkills: () => void;
}

type KeyState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "valid"; result: KeyCheckResult }
  | { status: "invalid"; result: KeyCheckResult };

type SettingsTab = "connection" | "chat" | "skills" | "github";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function SettingsModalInner({
  settings,
  conversationCount,
  models,
  initialTab,
  onClose,
  onUpdate,
  onClearAllConversations,
  onAddSkill,
  onUpdateSkill,
  onDeleteSkill,
  onResetBuiltinSkills,
}: Omit<ChatSettingsModalProps, "open">) {
  const [activeTab, setActiveTab] = React.useState<SettingsTab>(initialTab ?? "connection");
  const [keyDraft, setKeyDraft] = React.useState(settings.apiKey);
  const [showKey, setShowKey] = React.useState(false);
  const [keyState, setKeyState] = React.useState<KeyState>({ status: "idle" });
  const [pasted, setPasted] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [clearingState, setClearingState] = React.useState<"idle" | "clearing" | "done">("idle");
  const panelRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Focus the panel on open and restore focus to the trigger on close
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // Focus trap: keep Tab cycling inside the dialog
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panelRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Escape to close
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Rungs the default model can express (empty hides the control)
  const defaultEfforts = React.useMemo(
    () => availableEfforts(models.find((m) => m.id === settings.defaultModel) ?? resolveModelInfo(settings.defaultModel)),
    [models, settings.defaultModel]
  );

  const saveKey = () => {
    const trimmed = keyDraft.trim();
    onUpdate({ apiKey: trimmed });
    if (!trimmed) setKeyState({ status: "idle" });
  };

  const handleInputPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").trim();
    if (text) {
      e.preventDefault();
      setKeyDraft(text);
      onUpdate({ apiKey: text });
      if (keyState.status !== "idle") setKeyState({ status: "idle" });
      setPasted(true);
      setTimeout(() => setPasted(false), 1600);
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const cleaned = text.trim();
      if (cleaned) {
        setKeyDraft(cleaned);
        onUpdate({ apiKey: cleaned });
        if (keyState.status !== "idle") setKeyState({ status: "idle" });
        setPasted(true);
        setTimeout(() => setPasted(false), 1600);
      }
    } catch {
      // Fallback if browser blocks async clipboard API: focus input for Cmd/Ctrl+V
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  const validateKey = async () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    // Persist the draft first so the saved key is the tested key
    onUpdate({ apiKey: trimmed });
    setKeyState({ status: "checking" });
    const result = await checkKey(trimmed);
    setKeyState(result.valid ? { status: "valid", result } : { status: "invalid", result });
  };

  const handleClearAll = () => {
    if (clearingState !== "idle") return;
    setClearingState("clearing");
    setTimeout(() => {
      onClearAllConversations();
      setClearingState("done");
      setTimeout(() => {
        setConfirmClear(false);
        setClearingState("idle");
      }, 600);
    }, 450);
  };

  const keyDirty = keyDraft.trim() !== settings.apiKey;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className="settings-panel chat-settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Chat settings"
        tabIndex={-1}
      >
        {/* Header — same as SettingsPanel */}
        <div className="settings-header">
          <div className="settings-header-info">
            <div className="settings-header-icon-box">
              <MessageSquareText className="w-5 h-5" />
            </div>
            <div>
              <div className="settings-header-title-text">Agents Settings</div>
              <div className="settings-header-desc">
                One OpenRouter key unlocks GPT, Claude, Gemini and hundreds more
              </div>
            </div>
          </div>
          <SimpleTooltip content="Close (Esc)" side="left">
            <button type="button" className="settings-close-btn" onClick={onClose} aria-label="Close chat settings">
              <X className="w-4 h-4" />
            </button>
          </SimpleTooltip>
        </div>

        {/* Category Tabs — same pill bar as SettingsPanel */}
        <div className="settings-tabs-bar">
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "connection" ? "active" : ""}`}
            onClick={() => setActiveTab("connection")}
          >
            <Key className="h-3.5 w-3.5" />
            <span>Connection</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Chat</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "skills" ? "active" : ""}`}
            onClick={() => setActiveTab("skills")}
          >
            <Blocks className="h-3.5 w-3.5" />
            <span>Skills</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "github" ? "active" : ""}`}
            onClick={() => setActiveTab("github")}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span>GitHub</span>
          </button>
        </div>

        {/* Body — same scroll container as SettingsPanel */}
        <div className="settings-body">
          {/* ── Connection ── */}
          {activeTab === "connection" && (
            <div className="settings-tab-content">
              <div className="settings-security-card">
                <div className="settings-security-badge-group">
                  <div className="settings-security-card-icon-wrap">
                    <ShieldCheck className="h-[18px] w-[18px]" />
                  </div>
                  <div>
                    <div className="settings-security-card-title">Bring your own key</div>
                    <div className="settings-security-card-desc">
                      Your key is encrypted at rest (AES-256-GCM) and sent only to OpenRouter over
                      TLS. With Cloud Sync enabled it syncs across devices, encrypted before it
                      leaves this device.
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">OpenRouter API Key</div>

                <div className="settings-row chat-key-row">
                  <div className="settings-row-info">
                    <div className="chat-key-label-row">
                      <label className="settings-label" htmlFor="chat-api-key-input">
                        API key
                      </label>
                      <a
                        href={OPENROUTER_CONSOLE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="chat-settings-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Get a key <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <span className="settings-sublabel">
                      Starts with sk-or-v1- · validated live against OpenRouter
                    </span>
                  </div>
                  <div className="chat-key-controls">
                    <div className="chat-key-input-wrap">
                      <input
                        ref={inputRef}
                        id="chat-api-key-input"
                        name="openrouter_api_key"
                        type={showKey ? "text" : "password"}
                        value={keyDraft}
                        onChange={(e) => setKeyDraft(e.target.value)}
                        onPaste={handleInputPaste}
                        onBlur={saveKey}
                        placeholder="sk-or-v1-…"
                        className="settings-input chat-key-input"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-1p-ignore="true"
                        data-bwignore="true"
                        data-lpignore="true"
                        data-form-type="other"
                      />
                      <div className="chat-key-actions">
                        <SimpleTooltip content={pasted ? "Pasted!" : "Paste from clipboard"} side="top">
                          <button
                            type="button"
                            className={`chat-key-action-btn ${pasted ? "active" : ""}`}
                            onClick={handlePasteFromClipboard}
                            aria-label="Paste from clipboard"
                          >
                            {pasted ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <ClipboardPaste className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </SimpleTooltip>
                        <SimpleTooltip content={showKey ? "Hide key" : "Show key"} side="top">
                          <button
                            type="button"
                            className="chat-key-action-btn"
                            onClick={() => setShowKey((v) => !v)}
                            aria-label={showKey ? "Hide key" : "Show key"}
                          >
                            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </SimpleTooltip>
                      </div>
                    </div>
                    {keyDirty && (
                      <button type="button" className="settings-action-btn" onClick={saveKey}>
                        Save
                      </button>
                    )}
                    <button
                      type="button"
                      className="settings-action-btn"
                      onClick={validateKey}
                      disabled={!keyDraft.trim() || keyState.status === "checking"}
                    >
                      {keyState.status === "checking" ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Testing…</span>
                        </>
                      ) : (
                        "Test"
                      )}
                    </button>
                  </div>
                </div>

                {keyState.status === "valid" && (
                  <div className="chat-key-status chat-key-status-valid">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      {keyState.result.message}
                      {keyState.result.usageRemaining !== undefined &&
                        ` Credits remaining: $${keyState.result.usageRemaining.toFixed(2)}.`}
                    </span>
                  </div>
                )}
                {keyState.status === "invalid" && (
                  <div className="chat-key-status chat-key-status-invalid">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>{keyState.result.message}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Chat ── */}
          {activeTab === "chat" && (
            <div className="settings-tab-content">
              <div className="settings-section">
                <div className="settings-section-title">Model</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">
                      Default model
                    </label>
                    <span className="settings-sublabel">
                      Used for new chats — each chat remembers its own model once switched
                    </span>
                  </div>
                  <div className="settings-control">
                    <ModelPicker
                      value={settings.defaultModel}
                      models={models}
                      isLoading={false}
                      onChange={(id) => onUpdate({ defaultModel: id })}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Reasoning effort</label>
                    <span className="settings-sublabel">
                      How much the model may think before answering — sent as its
                      OpenRouter reasoning effort
                    </span>
                  </div>
                  <div className="settings-control">
                    {defaultEfforts.length > 0 ? (
                      <EffortPicker
                        value={settings.defaultReasoningEffort}
                        efforts={defaultEfforts}
                        onChange={(effort) => onUpdate({ defaultReasoningEffort: effort })}
                      />
                    ) : (
                      <span className="settings-value">
                        This model has no reasoning controls
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-section">
                <div className="settings-section-title">Behavior</div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">System prompt</label>
                    <span className="settings-sublabel">
                      Applied to all chats that don't define their own
                    </span>
                  </div>
                  <span className="settings-value">{settings.systemPrompt.length} chars</span>
                </div>
                <textarea
                  value={settings.systemPrompt}
                  onChange={(e) => onUpdate({ systemPrompt: e.target.value })}
                  className="settings-textarea chat-prompt-textarea"
                  rows={5}
                  placeholder="You are a helpful assistant…"
                />

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-temp-slider">
                      Temperature
                    </label>
                    <span className="settings-sublabel">
                      Lower is precise · higher is creative. Applies to writing:
                      rounds that edit code or run commands use the harness's own
                      low temperature.
                    </span>
                  </div>
                  <div className="settings-control">
                    <input
                      id="chat-temp-slider"
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      value={settings.temperature}
                      onChange={(e) => onUpdate({ temperature: parseFloat(e.target.value) })}
                      className="settings-slider"
                    />
                    <span className="settings-value">{settings.temperature.toFixed(1)}</span>
                  </div>
                </div>

                <McpServersEditor settings={settings} onUpdate={onUpdate} />

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-auto-escalate">
                      Continue a stalled turn on a stronger model
                    </label>
                    <span className="settings-sublabel">
                      When the selected model repeats the same failing tool call,
                      the rest of that turn continues on a model the catalog rates
                      above it — announced in the transcript, and attributed on
                      the reply and in the spend breakdown. Off by choice only:
                      a switch can cost more per token. Never changes the model
                      saved on the conversation.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-auto-escalate"
                      size="sm"
                      checked={settings.autoEscalate !== false}
                      onCheckedChange={(checked) => onUpdate({ autoEscalate: checked })}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-adaptive-effort">
                      Adapt reasoning effort to the work
                    </label>
                    <span className="settings-sublabel">
                      The harness picks each turn&apos;s starting depth from what the
                      request looks like — deeper for debugging and multi-file work,
                      shallower for a one-line rename — and may raise it mid-turn when
                      the turn is struggling, before considering a stronger model.
                      Never overrides an effort you set on a conversation, never changes
                      your saved setting, and every change is announced in the
                      transcript with the reason.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-adaptive-effort"
                      size="sm"
                      checked={settings.adaptiveEffort !== false}
                      onCheckedChange={(checked) => onUpdate({ adaptiveEffort: checked })}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-braid-strategies">
                      Strategy memory (Braid)
                    </label>
                    <span className="settings-sublabel">
                      After each turn, a background call distills what worked — and
                      what failed — into reusable strategies for this repository,
                      injected as capped background context on future tasks. Costs
                      no latency: distillation never blocks the next send.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-braid-strategies"
                      size="sm"
                      checked={settings.braidStrategies !== false}
                      onCheckedChange={(checked) => onUpdate({ braidStrategies: checked })}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-braid-probes">
                      Mid-turn typecheck probe (Braid)
                    </label>
                    <span className="settings-sublabel">
                      Between tool calls, the in-browser type checker runs without
                      being asked and reports diagnostics that were not there when
                      the turn started — before the model writes more on top of a
                      broken file. Never blocks a round.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-braid-probes"
                      size="sm"
                      checked={settings.braidProbes !== false}
                      onCheckedChange={(checked) => onUpdate({ braidProbes: checked })}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-braid-strands">
                      Strand rollouts on stuck turns (Braid)
                    </label>
                    <span className="settings-sublabel">
                      When a turn is demonstrably losing — repeated failing calls,
                      repeated probe findings — up to two bounded parallel attempts
                      run on isolated forks while the main turn keeps working. At
                      the stop, whichever verifies better is kept; a main path that
                      already verified discards them. Hard-capped: 2 strands, 8
                      rounds each, once per turn.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-braid-strands"
                      size="sm"
                      checked={settings.braidStrandRollouts !== false}
                      onCheckedChange={(checked) => onUpdate({ braidStrandRollouts: checked })}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-auto-approve-tools">
                      Run tools without asking
                    </label>
                    <span className="settings-sublabel">
                      Skips the two approval dialogs — sending a change to an
                      external service (http_write) and pushing a commit plus
                      pull request (push_changes) — so the agent completes them
                      while you read. Off by default: it can act in someone
                      else&apos;s system or ship code without you seeing the diff
                      first. Every auto-approved action is reported as such in
                      the transcript, and the harness&apos;s own refusals
                      (protected paths, secrets, published code in a request)
                      still apply.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-auto-approve-tools"
                      size="sm"
                      checked={settings.autoApproveTools === true}
                      onCheckedChange={(checked) => onUpdate({ autoApproveTools: checked })}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-section">
                <div className="settings-section-title">Data Management</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label" htmlFor="chat-sync-images-toggle">
                      Sync image attachments
                    </label>
                    <span className="settings-sublabel">
                      Include attached images in Cloud Sync. Turn off to keep
                      image payloads local-only — text content still syncs, and
                      remote devices see a placeholder instead of the image.
                    </span>
                  </div>
                  <div className="settings-control">
                    <Toggle
                      id="chat-sync-images-toggle"
                      size="sm"
                      checked={settings.syncImageAttachments !== false}
                      onCheckedChange={(checked) => onUpdate({ syncImageAttachments: checked })}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Stored conversations</label>
                    <span className="settings-sublabel">
                      {conversationCount} conversation{conversationCount === 1 ? "" : "s"} ·
                      encrypted locally · synced when Cloud Sync is on
                    </span>
                  </div>
                  {!confirmClear && (
                    <button
                      type="button"
                      className="settings-action-btn danger"
                      onClick={() => setConfirmClear(true)}
                      disabled={conversationCount === 0}
                    >
                      <Trash2 className="h-3 w-3" />
                      Clear All
                    </button>
                  )}
                </div>

                {confirmClear && (
                  <div className="settings-vault-subform danger-box">
                    <div className="settings-subform-title danger">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Delete all conversations?
                    </div>
                    <p className="settings-subform-warning">
                      This permanently removes {conversationCount} conversation
                      {conversationCount === 1 ? "" : "s"} from this device
                      {settings.apiKey ? " and queues deletion for the next cloud sync" : ""}.
                      A fresh empty chat will be created.
                    </p>
                    <div className="settings-subform-btns">
                      <button
                        type="button"
                        className="settings-subform-danger-btn flex items-center justify-center gap-1.5 transition-all disabled:opacity-80"
                        onClick={handleClearAll}
                        disabled={clearingState !== "idle"}
                      >
                        {clearingState === "clearing" ? (
                          <>
                            <Loader2 className="h-[13px] w-[13px] animate-spin" />
                            <span>Deleting…</span>
                          </>
                        ) : clearingState === "done" ? (
                          <>
                            <CheckCircle2 className="h-[13px] w-[13px]" />
                            <span>Deleted!</span>
                          </>
                        ) : (
                          <span>Yes, delete everything</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="settings-subform-cancel disabled:opacity-50"
                        onClick={() => setConfirmClear(false)}
                        disabled={clearingState !== "idle"}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Skills ── */}
          {activeTab === "skills" && (
            <SkillsTabContent
              settings={settings}
              onAddSkill={onAddSkill}
              onUpdateSkill={onUpdateSkill}
              onDeleteSkill={onDeleteSkill}
              onResetBuiltinSkills={onResetBuiltinSkills}
            />
          )}

          {/* ── GitHub ── */}
          {activeTab === "github" && (
            <GitHubTabContent
              settings={settings}
              onUpdate={onUpdate}
            />
          )}

        </div>

        {/* Footer — same as SettingsPanel */}
        <div className="settings-footer">
          <span className="settings-footer-hint">
            Esc to close · Changes save automatically
          </span>
        </div>
      </div>
    </div>
  );
}

export function ChatSettingsModal({ open, ...rest }: ChatSettingsModalProps) {
  if (!open) return null;
  // Keyed remount per open gives fresh draft state without
  // setState-in-effect (the old draft is intentionally discarded).
  return <SettingsModalInner key="chat-settings" {...rest} />;
}

// ============================================================
// GitHub Tab — Agent Mode Connection (OAuth + PAT)
// ============================================================

const GITHUB_PAT_URL = "https://github.com/settings/personal-access-tokens/new";

function GitHubTabContent({
  settings,
  onUpdate,
}: {
  settings: ChatSettings;
  onUpdate: (patch: Partial<ChatSettings>) => void;
}) {
  const gh = settings.github;
  const connected = Boolean(gh?.token);
  const [ghState, setGhState] = React.useState<GitHubConnectionState>(
    connected
      ? {
          status: "connected",
          login: gh?.login ?? "github",
          avatarUrl: gh?.avatarUrl ?? null,
          mode: gh?.mode ?? "pat",
        }
      : { status: "disconnected" }
  );
  const [patDraft, setPatDraft] = React.useState("");
  const [showPat, setShowPat] = React.useState(false);
  const [ghBusy, setGhBusy] = React.useState<"oauth" | "pat" | null>(null);

  const handleConnectOAuth = async () => {
    setGhBusy("oauth");
    setGhState({ status: "connecting" });
    const result = await connectViaOAuth();
    setGhBusy(null);
    if (result.ok) {
      setGhState({
        status: "connected",
        login: result.settings.login ?? "github",
        avatarUrl: result.settings.avatarUrl,
        mode: "oauth",
      });
      invalidateRepoCache();
      onUpdate({ github: result.settings });
    } else {
      setGhState(result.state);
    }
  };

  const handleConnectPat = async () => {
    setGhBusy("pat");
    setGhState({ status: "connecting" });
    const result = await connectWithToken(patDraft);
    setGhBusy(null);
    if (result.ok) {
      setGhState({
        status: "connected",
        login: result.settings.login ?? "github",
        avatarUrl: result.settings.avatarUrl,
        mode: "pat",
      });
      setPatDraft("");
      invalidateRepoCache();
      onUpdate({ github: result.settings });
    } else {
      setGhState(result.state);
    }
  };

  const handleDisconnect = () => {
    onUpdate({
      github: {
        token: "",
        mode: null,
        login: null,
        avatarUrl: null,
        connectedAt: null,
      },
    });
    setGhState({ status: "disconnected" });
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-info-card">
        <div className="settings-info-badge-group">
          <div className="settings-info-card-icon-wrap">
            <GitBranch className="h-[18px] w-[18px]" />
          </div>
          <div>
            <div className="settings-info-card-title">Coding agent over your repositories</div>
            <div className="settings-info-card-desc">
              Connect GitHub to attach a repository to any chat. The agent can read the code, edit a
              local workspace, run your project's own checks in the browser workspace, and — only after
              you approve the diff — push a commit to a new agent/* branch and open a pull request.
              It can also read the issues, pull requests, reviews and CI logs of that repository, and
              — only after you approve the exact text — comment, review, file an issue or edit a pull
              request. Your token is encrypted at rest
              and sent only to api.github.com. Fine-grained PATs need Contents: read &amp; write,
              Pull requests: read &amp; write and Issues: read &amp; write (the last two cover comments and
              reviews; without them those tools answer with the missing scope); the OAuth flow
              already carries full repo scope. Optionally add Checks: read and Commit statuses: read —
              without them the agent can still read a pull request, but its verdict says the commit
              reported no checks.
            </div>
          </div>
        </div>
      </div>

      {ghState.status === "connected" ? (
        <div className="settings-section">
          <div className="settings-section-title">Connected account</div>
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="chat-gh-account-row">
                {ghState.avatarUrl && (
                  <img src={ghState.avatarUrl} alt="" className="chat-gh-avatar" />
                )}
                <span className="chat-gh-login">{ghState.login}</span>
                <span className="chat-skill-badge chat-skill-badge-on">
                  {ghState.mode === "oauth" ? "OAuth" : "PAT"}
                </span>
              </div>
              <span className="settings-sublabel">
                Workspace edits land in the Changes panel; GitHub writes always go through your
                approval · detach repos any time from the chat header
              </span>
            </div>
            <div className="settings-control">
              <button type="button" className="settings-action-btn" onClick={handleDisconnect}>
                Disconnect
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="settings-section">
            <div className="settings-section-title">Connect</div>
            <div className="settings-row">
              <div className="settings-row-info">
                <label className="settings-label">GitHub account</label>
                <span className="settings-sublabel">
                  One-click OAuth in a popup window
                </span>
              </div>
              <div className="settings-control">
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={handleConnectOAuth}
                  disabled={ghBusy !== null}
                >
                  {ghBusy === "oauth" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Connecting…</span>
                    </>
                  ) : (
                    "Sign in with GitHub"
                  )}
                </button>
              </div>
            </div>
            {ghState.status === "error" && (
              <div className="chat-key-status chat-key-status-invalid">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{ghState.message}</span>
              </div>
            )}
          </div>

          <div className="settings-divider" />

          <div className="settings-section">
            <div className="settings-section-title">Personal Access Token (alternative)</div>
            <div className="settings-row chat-key-row">
              <div className="settings-row-info">
                <div className="chat-key-label-row">
                  <label className="settings-label" htmlFor="chat-gh-pat">
                    Fine-grained PAT
                  </label>
                  <a
                    href={GITHUB_PAT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="chat-settings-link"
                  >
                    Create one <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <span className="settings-sublabel">
                  Grant “Contents: read” (and “Metadata: read”) for the repos you want the assistant to
                  see. Works in local dev where OAuth needs server configuration.
                </span>
              </div>
              <div className="chat-key-controls">
                <div className="chat-key-input-wrap">
                  <input
                    id="chat-gh-pat"
                    type={showPat ? "text" : "password"}
                    value={patDraft}
                    onChange={(e) => setPatDraft(e.target.value)}
                    placeholder="github_pat_… or ghp_…"
                    className="settings-input chat-key-input"
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore="true"
                  />
                  <div className="chat-key-actions">
                    <SimpleTooltip content={showPat ? "Hide token" : "Show token"} side="top">
                      <button
                        type="button"
                        className="chat-key-action-btn"
                        onClick={() => setShowPat((v) => !v)}
                        aria-label={showPat ? "Hide token" : "Show token"}
                      >
                        {showPat ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </SimpleTooltip>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={handleConnectPat}
                  disabled={!patDraft.trim() || ghBusy !== null}
                >
                  {ghBusy === "pat" ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Testing…</span>
                    </>
                  ) : (
                    "Connect"
                  )}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// ── MCP servers — external tools over streamable HTTP ───────

/**
 * Editor for connected MCP servers. A JSON textarea rather than a form:
 * the shape is three fields of which two are optional, and the people who
 * connect MCP servers already have the config to hand. It commits on
 * blur so an intermediate, unparseable keystroke is never persisted.
 */
function McpServersEditor({
  settings,
  onUpdate,
}: {
  settings: ChatSettings;
  onUpdate: (patch: Partial<ChatSettings>) => void;
}) {
  const stored = React.useMemo(() => serializeMcpServers(settings.mcpServers), [settings.mcpServers]);
  const [draft, setDraft] = React.useState(stored);
  const [error, setError] = React.useState<string | null>(null);
  const [syncedFrom, setSyncedFrom] = React.useState(stored);

  // Re-sync when the stored config changes beneath us (cloud sync,
  // import, another window) without clobbering local typing. Adjusting
  // state during render — rather than in an effect — is React's own
  // answer for "a prop changed": the textarea never renders one frame of
  // stale config, and no second pass is scheduled to fix it.
  if (stored !== syncedFrom) {
    setSyncedFrom(stored);
    setDraft(stored);
    setError(null);
  }

  const commit = () => {
    const parsed = parseMcpServersJson(draft);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onUpdate({ mcpServers: parsed.servers.length > 0 ? parsed.servers : undefined });
  };

  const connected = activeServers(settings.mcpServers).length;

  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-info">
        <label className="settings-label" htmlFor="chat-mcp-servers">
          MCP servers{connected > 0 ? ` (${connected} connected)` : ""}
        </label>
        <span className="settings-sublabel">
          External tools the agent can list and call (list_mcp_tools /
          call_mcp_tool). A JSON array of {"{"} name, url, apiKey? {"}"} objects.
          Servers are contacted directly from this page, so they must allow browser
          origins (CORS) — a server that does not will be reported as unreachable.
        </span>
      </div>
      <div className="settings-control settings-control-wide">
        <textarea
          id="chat-mcp-servers"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          rows={4}
          spellCheck={false}
          placeholder={'[{"name":"linear","url":"https://mcp.example.com/mcp"}]'}
          className="settings-textarea"
        />
        {error && <span className="chat-key-status chat-key-status-invalid">{error}</span>}
      </div>
    </div>
  );
}

// Skills Tab — Manage prompt modules
// ============================================================

function SkillsTabContent({
  settings,
  onAddSkill,
  onUpdateSkill,
  onDeleteSkill,
  onResetBuiltinSkills,
}: Pick<
  ChatSettingsModalProps,
  "settings" | "onAddSkill" | "onUpdateSkill" | "onDeleteSkill" | "onResetBuiltinSkills"
>) {
  const [editingSkill, setEditingSkill] = React.useState<ChatSkill | null>(null);
  // Built-in presets are reference material now: they activate themselves from
  // their triggers, so the list starts folded rather than reading as a
  // checklist the user is expected to work through.
  const [showBuiltins, setShowBuiltins] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState({
    name: "",
    description: "",
    content: "",
    triggers: "",
  });
  const [importError, setImportError] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Disarm a pending delete so the armed state never goes stale
  React.useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteId]);

  const skills = settings.skills ?? [];
  const builtins = skills.filter((s) => s.builtin);
  const custom = skills.filter((s) => !s.builtin);
  const enabledCount = skills.filter((s) => s.enabled).length;

  const startCreate = () => {
    setDraft({ name: "", description: "", content: "", triggers: "" });
    setCreating(true);
    setEditingSkill(null);
  };

  const startEdit = (skill: ChatSkill) => {
    setDraft({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      triggers: (skill.triggers ?? []).join(", "),
    });
    setEditingSkill(skill);
    setCreating(false);
    setConfirmDeleteId(null);
  };

  const closeEditor = () => {
    setEditingSkill(null);
    setCreating(false);
  };

  const commitEditor = () => {
    const name = draft.name.trim();
    const content = draft.content.trim();
    if (!name || !content) return;

    // Triggers are what make a skill discoverable: the model sees them in
    // the skill index and loads the body itself, so a skill without
    // triggers still works (it can be enabled outright or found by name)
    // but will not be offered at the right moment.
    const triggers = draft.triggers
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
    const triggerPatch = triggers.length > 0 ? { triggers } : { triggers: undefined };

    if (editingSkill) {
      onUpdateSkill(editingSkill.id, {
        name,
        description: draft.description.trim(),
        content,
        ...triggerPatch,
      });
    } else {
      onAddSkill({
        id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        description: draft.description.trim(),
        content,
        enabled: false,
        ...triggerPatch,
      });
    }
    closeEditor();
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      const parsed = parseSkillFile(text);
      onAddSkill(skillFromParsed(parsed));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not read the skill file.");
    }
  };

  const handleSkillDelete = (skillId: string) => {
    if (confirmDeleteId === skillId) {
      onDeleteSkill(skillId);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(skillId);
    }
  };

  const renderSkillRow = (skill: ChatSkill) => {
    const isEditing = editingSkill?.id === skill.id;
    const isConfirmingDelete = confirmDeleteId === skill.id;
    return (
      <div key={skill.id} className="chat-skill-item">
        <div className="chat-skill-row">
          <div className="chat-skill-info">
            <div className="chat-skill-name-row">
              <span className="chat-skill-name">{skill.name}</span>
              {skill.builtin && <span className="chat-skill-badge">Built-in</span>}
              {skill.updated && <span className="chat-skill-badge chat-skill-badge-edited">Edited</span>}
              {skill.enabled && <span className="chat-skill-badge chat-skill-badge-on">Always on</span>}
            </div>
            {skill.description && (
              <div className="chat-skill-desc">{skill.description}</div>
            )}
          </div>
          <div className="chat-skill-actions">
            <SimpleTooltip content={isEditing ? "Close editor" : "Edit"} side="top">
              <button
                type="button"
                className="settings-icon-btn"
                onClick={() => (isEditing ? closeEditor() : startEdit(skill))}
                aria-label={isEditing ? "Close editor" : `Edit ${skill.name}`}
              >
                {isEditing ? (
                  <X className="h-[13px] w-[13px]" />
                ) : (
                  <Pencil className="h-[13px] w-[13px]" />
                )}
              </button>
            </SimpleTooltip>
            <SimpleTooltip content="Export .md" side="top">
              <button
                type="button"
                className="settings-icon-btn"
                onClick={() => downloadSkillFile(skill)}
                aria-label={`Export ${skill.name}`}
              >
                <Download className="h-[13px] w-[13px]" />
              </button>
            </SimpleTooltip>
            <SimpleTooltip
              content={isConfirmingDelete ? "Click again to delete" : "Delete"}
              side="top"
            >
              <button
                type="button"
                className={`settings-icon-btn danger ${isConfirmingDelete ? "danger-confirm" : ""}`}
                onClick={() => handleSkillDelete(skill.id)}
                aria-label={
                  isConfirmingDelete ? "Click again to confirm delete" : `Delete ${skill.name}`
                }
              >
                <Trash2 className="h-[13px] w-[13px]" />
              </button>
            </SimpleTooltip>
            {/* The switch is NOT "on/off for this skill": a skill that is off
                still activates itself when its triggers match the request. It
                chooses between the two ways a skill can be active, and the
                label has to say which end is which. */}
            <SimpleTooltip
              content={
                skill.enabled
                  ? "Always on — sent with every message. Switch off to let it activate only when your request matches."
                  : "Sent only when your request matches this skill's triggers. Switch on to send it with every message."
              }
              side="top"
            >
              <Toggle
                size="sm"
                checked={skill.enabled}
                onCheckedChange={(checked) => onUpdateSkill(skill.id, { enabled: checked })}
                aria-label={
                  skill.enabled
                    ? `Stop always sending ${skill.name}`
                    : `Always send ${skill.name} with every message`
                }
                aria-description="Off does not disable the skill; it activates itself when your request matches its triggers."
              />
            </SimpleTooltip>
          </div>
        </div>

        {isEditing && (
          <div className="chat-skill-editor">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Skill name"
              className="settings-input chat-skill-input"
              maxLength={60}
            />
            <input
              type="text"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="Short description (optional)"
              className="settings-input chat-skill-input"
              maxLength={140}
            />
            <input
              type="text"
              value={draft.triggers}
              onChange={(e) => setDraft((d) => ({ ...d, triggers: e.target.value }))}
              placeholder="Triggers, comma separated (e.g. push, failing build)"
              className="settings-input chat-skill-input"
            />
            <textarea
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              placeholder="What should the model do when this skill is active?"
              className="settings-textarea chat-skill-textarea"
              rows={6}
            />
            <div className="chat-skill-editor-footer">
              <span className="chat-skill-chars">{draft.content.length} chars</span>
              <div className="chat-skill-editor-btns">
                <button
                  type="button"
                  className="settings-subform-cancel"
                  onClick={closeEditor}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="settings-subform-action-btn flex items-center justify-center gap-1.5"
                  onClick={commitEditor}
                  disabled={!draft.name.trim() || !draft.content.trim()}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  <span>{editingSkill ? "Save changes" : "Add skill"}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-info-card">
        <div className="settings-info-badge-group">
          <div className="settings-info-card-icon-wrap">
            <Blocks className="h-[18px] w-[18px]" />
          </div>
          <div>
            <div className="settings-info-card-title">Prompt Skills</div>
            <div className="settings-info-card-desc">
              The agent activates these itself: when your request matches a skill's triggers, its
              instructions load for that turn, so an off skill is not an inactive one.{" "}
              <strong>Always on</strong> is the other mode — sent with every message, which costs
              the context window each turn and is worth it only for standing rules. Hover the
              skills badge in the chat header to see which are in play right now.
              {enabledCount > 0 && ` ${enabledCount} always on.`}
            </div>
          </div>
        </div>
      </div>

      <div className="chat-skills-toolbar">
        <button
          type="button"
          className="settings-action-btn"
          onClick={startCreate}
        >
          <Plus className="h-3 w-3" />
          <span>New skill</span>
        </button>
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3 w-3" />
          <span>Import .md</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt"
          onChange={handleFileChosen}
          style={{ display: "none" }}
        />
        <button
          type="button"
          className="settings-action-btn"
          onClick={() => {
            onResetBuiltinSkills();
            closeEditor();
          }}
          title="Restore all built-in skills to their original text"
        >
          <RotateCcw className="h-3 w-3" />
          <span>Reset built-ins</span>
        </button>
      </div>

      {importError && (
        <div className="chat-key-status chat-key-status-invalid">{importError}</div>
      )}

      {/* Create-new editor (top) */}
      {creating && (
        <div className="chat-skill-item">
          <div className="chat-skill-editor">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Skill name"
              className="settings-input chat-skill-input"
              maxLength={60}
              autoFocus
            />
            <input
              type="text"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="Short description (optional)"
              className="settings-input chat-skill-input"
              maxLength={140}
            />
            <input
              type="text"
              value={draft.triggers}
              onChange={(e) => setDraft((d) => ({ ...d, triggers: e.target.value }))}
              placeholder="Triggers, comma separated (e.g. push, failing build)"
              className="settings-input chat-skill-input"
            />
            <textarea
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              placeholder="What should the model do when this skill is active?"
              className="settings-textarea chat-skill-textarea"
              rows={6}
            />
            <div className="chat-skill-editor-footer">
              <span className="chat-skill-chars">{draft.content.length} chars</span>
              <div className="chat-skill-editor-btns">
                <button
                  type="button"
                  className="settings-subform-cancel"
                  onClick={closeEditor}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="settings-subform-action-btn flex items-center justify-center gap-1.5"
                  onClick={commitEditor}
                  disabled={!draft.name.trim() || !draft.content.trim()}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  <span>Add skill</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {builtins.length > 0 && (
        <div className="settings-section chat-skills-section">
          {/* Folded by default — see showBuiltins. The toggle inside still
              pins one on for every message, and the text stays editable. */}
          <div className="settings-section-title">
            <button
              type="button"
              className="chat-skills-disclosure"
              onClick={() => setShowBuiltins((v) => !v)}
              aria-expanded={showBuiltins}
            >
              {showBuiltins ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <span>Built-in presets ({builtins.length})</span>
              <span className="chat-skill-badge">Auto</span>
            </button>
          </div>
          {!showBuiltins && (
            <div className="chat-skills-hint">
              Activated automatically when a request matches them — the switch means “Always on”
              (sent with every message), not “enabled”. Open to change that or edit the text.
            </div>
          )}
          {showBuiltins && builtins.map(renderSkillRow)}
        </div>
      )}

      {custom.length > 0 && (
        <div className="settings-section chat-skills-section">
          <div className="settings-section-title">Your skills</div>
          {custom.map(renderSkillRow)}
        </div>
      )}

      {skills.length === 0 && !creating && (
        <div className="chat-skills-empty">
          No skills yet. Start with a built-in preset or import a .md file.
        </div>
      )}
    </div>
  );
}
