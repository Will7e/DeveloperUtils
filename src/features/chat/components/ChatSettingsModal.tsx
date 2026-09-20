// ============================================================
// Chat Settings Modal — OpenRouter Key, Model, Prompt, Data, Skills
// ============================================================
// Built on the app's shared .settings-* layout vocabulary AND the
// Geist component layer (Button, Toggle, Tabs secondary) per
// vercel.com/geist. Type ramp: Button 12 for small actions,
// Label 12-CAPS for section titles, Label 14 row labels,
// Copy 13 secondary text.

import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { checkKey, type KeyCheckResult } from "../lib/openrouter-client";
import { OPENROUTER_CONSOLE_URL } from "../constants";
import {
  downloadSkillFile,
  parseSkillFile,
  skillFromParsed,
} from "../lib/skills";
import type { ChatSettings, ChatSkill } from "../types";

interface ChatSettingsModalProps {
  open: boolean;
  settings: ChatSettings;
  conversationCount: number;
  /** Tab to focus on open (from store deep-links) */
  initialTab?: "connection" | "chat" | "skills" | null;
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

type SettingsTab = "connection" | "chat" | "skills";

function SettingsModalInner({
  settings,
  conversationCount,
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
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [clearingState, setClearingState] = React.useState<"idle" | "clearing" | "done">("idle");

  // Escape to close
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const saveKey = () => {
    const trimmed = keyDraft.trim();
    onUpdate({ apiKey: trimmed });
    if (!trimmed) setKeyState({ status: "idle" });
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
        className="settings-panel chat-settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Chat settings"
      >
        {/* Header — SettingsPanel vocabulary */}
        <div className="settings-header">
          <div className="settings-header-info">
            <div className="settings-header-icon-box">
              <MessageSquareText className="w-4 h-4" />
            </div>
            <div>
              <div className="settings-header-title-text">AI Chat Settings</div>
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

        {/* Tabs — Geist secondary segmented control */}
        <div className="chat-settings-tabsbar">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SettingsTab)}>
            <TabsList variant="secondary" className="w-full">
              <TabsTrigger value="connection" className="flex-1">Connection</TabsTrigger>
              <TabsTrigger value="chat" className="flex-1">Chat</TabsTrigger>
              <TabsTrigger value="skills" className="flex-1">Skills</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SettingsTab)}>
          {/* ── Connection ── */}
          <TabsContent value="connection">
            <div className="settings-tab-content">
              <div className="settings-security-card">
                <div className="settings-security-badge-group">
                  <div className="settings-security-card-icon-wrap">
                    <CheckCircle2 size={18} />
                  </div>
                  <div>
                    <div className="settings-security-card-title">Bring Your Own Key</div>
                    <div className="settings-security-card-desc">
                      Encrypted at rest (AES-256-GCM) and sent only to OpenRouter over TLS.
                      With Cloud Sync enabled, settings sync across devices — still
                      end-to-end encrypted.
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">OpenRouter API Key</div>

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">
                      <span className="flex items-center gap-1.5">
                        API Key
                        <a
                          href={OPENROUTER_CONSOLE_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="chat-settings-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Get a key <ExternalLink className="h-3 w-3" />
                        </a>
                      </span>
                      <span className="settings-sublabel">
                        Starts with sk-or-v1- · validated live against OpenRouter
                      </span>
                    </label>
                    <div className="settings-control chat-key-control">
                      <div className="chat-key-input-wrap">
                        <input
                          type={showKey ? "text" : "password"}
                          value={keyDraft}
                          onChange={(e) => setKeyDraft(e.target.value)}
                          onBlur={saveKey}
                          placeholder="sk-or-v1-…"
                          className="settings-input chat-key-input"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <SimpleTooltip content={showKey ? "Hide key" : "Show key"} side="top">
                          <button
                            type="button"
                            className="chat-key-toggle"
                            onClick={() => setShowKey((v) => !v)}
                            aria-label={showKey ? "Hide key" : "Show key"}
                          >
                            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </SimpleTooltip>
                      </div>
                      {keyDirty && (
                        <Button size="sm" variant="default" onClick={saveKey}>
                          Save
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={validateKey}
                        disabled={!keyDraft.trim() || keyState.status === "checking"}
                      >
                        {keyState.status === "checking" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          "Test"
                        )}
                      </Button>
                    </div>
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
          </TabsContent>

          {/* ── Chat ── */}
          <TabsContent value="chat">
            <div className="settings-tab-content">
              <div className="settings-section">
                <div className="settings-section-title">Model</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Default Model</label>
                    <span className="settings-sublabel">
                      Used for new chats — each chat remembers its own model once switched
                    </span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="text"
                      value={settings.defaultModel}
                      onChange={(e) => onUpdate({ defaultModel: e.target.value })}
                      className="settings-input chat-model-input"
                      placeholder="openai/gpt-4o-mini"
                      spellCheck={false}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-section">
                <div className="settings-section-title">Behavior</div>

                <div className="settings-row">
                  <div className="settings-row-info" style={{ flex: 1 }}>
                    <label className="settings-label">System Prompt</label>
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
                    <label className="settings-label">Temperature</label>
                    <span className="settings-sublabel">Lower is precise · higher is creative</span>
                  </div>
                  <div className="settings-control">
                    <input
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
              </div>

              <div className="settings-divider" />

              <div className="settings-section">
                <div className="settings-section-title">Data Management</div>
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Stored Conversations</label>
                    <span className="settings-sublabel">
                      {conversationCount} conversation{conversationCount === 1 ? "" : "s"} ·
                      encrypted locally · synced when Cloud Sync is on
                    </span>
                  </div>
                  {!confirmClear && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="chat-danger-ghost"
                      onClick={() => setConfirmClear(true)}
                      disabled={conversationCount === 0}
                    >
                      <Trash2 size={12} />
                      Clear All
                    </Button>
                  )}
                </div>

                {confirmClear && (
                  <div className="settings-vault-subform danger-box">
                    <div className="settings-subform-title danger">
                      <AlertTriangle size={14} />
                      Delete all conversations?
                    </div>
                    <p className="settings-subform-warning">
                      This permanently removes {conversationCount} conversation
                      {conversationCount === 1 ? "" : "s"} from this device
                      {settings.apiKey ? " and queues deletion for the next cloud sync" : ""}.
                      A fresh empty chat will be created.
                    </p>
                    <div className="settings-subform-btns">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleClearAll}
                        disabled={clearingState !== "idle"}
                        className="flex-1"
                      >
                        {clearingState === "clearing" ? (
                          <>
                            <Loader2 size={13} className="animate-spin" />
                            Deleting…
                          </>
                        ) : clearingState === "done" ? (
                          <>
                            <CheckCircle2 size={13} />
                            Deleted!
                          </>
                        ) : (
                          "Yes, delete everything"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirmClear(false)}
                        disabled={clearingState !== "idle"}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── Skills ── */}
          <TabsContent value="skills">
            <SkillsTabContent
              settings={settings}
              onAddSkill={onAddSkill}
              onUpdateSkill={onUpdateSkill}
              onDeleteSkill={onDeleteSkill}
              onResetBuiltinSkills={onResetBuiltinSkills}
            />
          </TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="settings-footer">
          <span className="settings-footer-hint">Esc to close</span>
          <span className="settings-footer-hint chat-settings-footer-right">
            Changes save automatically
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
  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState({ name: "", description: "", content: "" });
  const [importError, setImportError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const skills = settings.skills ?? [];
  const builtins = skills.filter((s) => s.builtin);
  const custom = skills.filter((s) => !s.builtin);
  const enabledCount = skills.filter((s) => s.enabled).length;

  const startCreate = () => {
    setDraft({ name: "", description: "", content: "" });
    setCreating(true);
    setEditingSkill(null);
  };

  const startEdit = (skill: ChatSkill) => {
    setDraft({ name: skill.name, description: skill.description, content: skill.content });
    setEditingSkill(skill);
    setCreating(false);
  };

  const closeEditor = () => {
    setEditingSkill(null);
    setCreating(false);
  };

  const commitEditor = () => {
    const name = draft.name.trim();
    const content = draft.content.trim();
    if (!name || !content) return;

    if (editingSkill) {
      onUpdateSkill(editingSkill.id, {
        name,
        description: draft.description.trim(),
        content,
      });
    } else {
      onAddSkill({
        id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        description: draft.description.trim(),
        content,
        enabled: false,
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

  const renderSkillRow = (skill: ChatSkill) => {
    const isEditing = editingSkill?.id === skill.id;
    return (
      <div key={skill.id} className="chat-skill-item">
        <div className="chat-skill-row">
          <div className="chat-skill-info">
            <div className="chat-skill-name-row">
              <span className="chat-skill-name">{skill.name}</span>
              {skill.builtin && <span className="chat-skill-badge">Built-in</span>}
              {skill.updated && <span className="chat-skill-badge chat-skill-badge-edited">Edited</span>}
              {skill.enabled && <span className="chat-skill-badge chat-skill-badge-on">Active</span>}
            </div>
            {skill.description && (
              <div className="chat-skill-desc">{skill.description}</div>
            )}
          </div>
          <div className="chat-skill-actions">
            <SimpleTooltip content={isEditing ? "Close editor" : "Edit"} side="top">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => (isEditing ? closeEditor() : startEdit(skill))}
                aria-label={isEditing ? "Close editor" : `Edit ${skill.name}`}
              >
                {isEditing ? <X size={12} /> : <Pencil size={12} />}
              </Button>
            </SimpleTooltip>
            <SimpleTooltip content="Export .md" side="top">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => downloadSkillFile(skill)}
                aria-label={`Export ${skill.name}`}
              >
                <Download size={12} />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip content="Delete" side="top">
              <Button
                size="icon-sm"
                variant="ghost"
                className="chat-danger-ghost"
                onClick={() => onDeleteSkill(skill.id)}
                aria-label={`Delete ${skill.name}`}
              >
                <Trash2 size={12} />
              </Button>
            </SimpleTooltip>
            <Toggle
              size="sm"
              checked={skill.enabled}
              onCheckedChange={(checked) => onUpdateSkill(skill.id, { enabled: checked })}
              aria-label={`Toggle ${skill.name}`}
            />
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
                <Button size="sm" variant="secondary" onClick={closeEditor}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={commitEditor}
                  disabled={!draft.name.trim() || !draft.content.trim()}
                >
                  <CheckCircle2 size={12} />
                  {editingSkill ? "Save changes" : "Add skill"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="settings-tab-content">
      <div className="settings-security-card">
        <div className="settings-security-badge-group">
          <div className="settings-security-card-icon-wrap">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="settings-security-card-title">Skills</div>
            <div className="settings-security-card-desc">
              Reusable prompt modules injected into every message when enabled. Enabled
              skills count toward the context window — the header meter shows the cost.
              {enabledCount > 0 && ` ${enabledCount} active now.`}
            </div>
          </div>
        </div>
      </div>

      <div className="chat-skills-toolbar">
        <Button size="sm" variant="default" onClick={startCreate}>
          <Plus size={12} />
          New skill
        </Button>
        <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
          <Upload size={12} />
          Import .md
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt"
          onChange={handleFileChosen}
          style={{ display: "none" }}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onResetBuiltinSkills();
            closeEditor();
          }}
          title="Restore all built-in skills to their original text"
        >
          <RotateCcw size={12} />
          Reset built-ins
        </Button>
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
                <Button size="sm" variant="secondary" onClick={closeEditor}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={commitEditor}
                  disabled={!draft.name.trim() || !draft.content.trim()}
                >
                  <CheckCircle2 size={12} />
                  Add skill
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {builtins.length > 0 && (
        <div className="settings-section">
          <div className="settings-section-title">Built-in presets</div>
          {builtins.map(renderSkillRow)}
        </div>
      )}

      {custom.length > 0 && (
        <div className="settings-section">
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
