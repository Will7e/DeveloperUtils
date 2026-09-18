// ============================================================
// Settings Panel — Configuration & Security overlay
// ============================================================

import { useState } from "react";
import {
  X,
  Settings,
  Sun,
  Moon,
  ChevronDown,
  ShieldCheck,
  Trash2,
  AlertTriangle,
  Code2,
  Sliders,
  Shield,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { useVaultStore } from "@/services/vault.service";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SettingsDropdownProps<T extends string | number> {
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
  className?: string;
}

function SettingsDropdown<T extends string | number>({
  value,
  options,
  onChange,
  className = "w-[120px]",
}: SettingsDropdownProps<T>) {
  const selectedOption = options.find((o) => o.value === value) || options[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={`settings-select flex items-center justify-between ${className}`}>
          <span className="truncate">{selectedOption?.label}</span>
          <ChevronDown className="h-3 w-3 opacity-50 ml-2 flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className}>
        {options.map((opt) => (
          <DropdownMenuItem
            key={String(opt.value)}
            onClick={() => onChange(opt.value)}
            className="cursor-pointer text-xs"
          >
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

type SettingsTab = "editor" | "experience" | "security";

export function SettingsPanel() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const editorSettings = useAppStore((s) => s.editorSettings);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);

  const resetVault = useVaultStore((s) => s.resetVault);
  const [activeTab, setActiveTab] = useState<SettingsTab>("editor");
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  if (!settingsOpen) return null;

  return (
    <div className="settings-overlay" onClick={toggleSettings}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <div className="settings-header-title">
            <Settings style={{ width: 15, height: 15, color: "var(--accent)" }} />
            <span>Settings</span>
          </div>
          <ActionTooltip content="Close Settings (Esc)" side="left">
            <button className="toolbar-icon-btn" onClick={toggleSettings}>
              <X style={{ width: 15, height: 15 }} />
            </button>
          </ActionTooltip>
        </div>

        {/* Category Tabs */}
        <div className="settings-tabs-bar">
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "editor" ? "active" : ""}`}
            onClick={() => setActiveTab("editor")}
          >
            <Code2 size={13} />
            <span>Editor</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "experience" ? "active" : ""}`}
            onClick={() => setActiveTab("experience")}
          >
            <Sliders size={13} />
            <span>Experience</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "security" ? "active" : ""}`}
            onClick={() => setActiveTab("security")}
          >
            <ShieldCheck size={13} />
            <span>Security & Vault</span>
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          {/* ── TAB: Editor ── */}
          {activeTab === "editor" && (
            <div className="settings-tab-content">
              {/* Font Family */}
              <div className="settings-row">
                <label className="settings-label">Font Family</label>
                <div className="settings-control">
                  <SettingsDropdown
                    value={editorSettings.fontFamily}
                    onChange={(v) => updateEditorSettings({ fontFamily: v })}
                    options={[
                      {
                        label: "Monospace",
                        value: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                      },
                      { label: "System UI", value: "system-ui, sans-serif" },
                      { label: "Courier", value: "'Courier New', Courier, monospace" },
                    ]}
                    className="w-[120px]"
                  />
                </div>
              </div>

              {/* Font Size */}
              <div className="settings-row">
                <label className="settings-label">Font Size</label>
                <div className="settings-control">
                  <input
                    type="range"
                    min="10"
                    max="24"
                    value={editorSettings.fontSize}
                    onChange={(e) =>
                      updateEditorSettings({ fontSize: Number(e.target.value) })
                    }
                    className="settings-slider"
                  />
                  <span className="settings-value">{editorSettings.fontSize}px</span>
                </div>
              </div>

              {/* Tab Size */}
              <div className="settings-row">
                <label className="settings-label">Tab Size</label>
                <div className="settings-control">
                  <SettingsDropdown
                    value={editorSettings.tabSize}
                    onChange={(v) => updateEditorSettings({ tabSize: Number(v) })}
                    options={[
                      { label: "2 spaces", value: 2 },
                      { label: "4 spaces", value: 4 },
                      { label: "8 spaces", value: 8 },
                    ]}
                    className="w-[100px]"
                  />
                </div>
              </div>

              {/* Word Wrap */}
              <div className="settings-row">
                <label className="settings-label">Word Wrap</label>
                <div className="settings-control">
                  <button
                    type="button"
                    className={`settings-toggle ${editorSettings.wordWrap === "on" ? "active" : ""}`}
                    onClick={() =>
                      updateEditorSettings({
                        wordWrap: editorSettings.wordWrap === "on" ? "off" : "on",
                      })
                    }
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>
              </div>

              {/* Minimap */}
              <div className="settings-row">
                <label className="settings-label">Minimap</label>
                <div className="settings-control">
                  <button
                    type="button"
                    className={`settings-toggle ${editorSettings.minimap ? "active" : ""}`}
                    onClick={() =>
                      updateEditorSettings({ minimap: !editorSettings.minimap })
                    }
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>
              </div>

              {/* Line Numbers */}
              <div className="settings-row">
                <label className="settings-label">Line Numbers</label>
                <div className="settings-control">
                  <SettingsDropdown
                    value={editorSettings.lineNumbers}
                    onChange={(v) =>
                      updateEditorSettings({ lineNumbers: v as "on" | "off" | "relative" })
                    }
                    options={[
                      { label: "On", value: "on" },
                      { label: "Off", value: "off" },
                      { label: "Relative", value: "relative" },
                    ]}
                    className="w-[100px]"
                  />
                </div>
              </div>

              {/* Bracket Colorization */}
              <div className="settings-row">
                <label className="settings-label">Bracket Colors</label>
                <div className="settings-control">
                  <button
                    type="button"
                    className={`settings-toggle ${editorSettings.bracketPairColorization ? "active" : ""}`}
                    onClick={() =>
                      updateEditorSettings({
                        bracketPairColorization: !editorSettings.bracketPairColorization,
                      })
                    }
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB: Experience ── */}
          {activeTab === "experience" && (
            <div className="settings-tab-content">
              {/* Theme */}
              <div className="settings-row">
                <label className="settings-label">
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {editorSettings.theme === "dark" ? (
                      <Moon style={{ width: 13, height: 13, color: "var(--accent)" }} />
                    ) : (
                      <Sun style={{ width: 13, height: 13, color: "var(--yellow)" }} />
                    )}
                    Theme
                  </span>
                </label>
                <div className="settings-control">
                  <button
                    type="button"
                    className={`settings-toggle ${editorSettings.theme === "light" ? "active" : ""}`}
                    onClick={() =>
                      updateEditorSettings({
                        theme: editorSettings.theme === "dark" ? "light" : "dark",
                      })
                    }
                  >
                    <span className="toggle-thumb" />
                  </button>
                  <span className="settings-value" style={{ textTransform: "capitalize" }}>
                    {editorSettings.theme}
                  </span>
                </div>
              </div>

              {/* Format on Paste */}
              <div className="settings-row">
                <label className="settings-label">Format on Paste</label>
                <div className="settings-control">
                  <button
                    type="button"
                    className={`settings-toggle ${editorSettings.formatOnPaste ? "active" : ""}`}
                    onClick={() =>
                      updateEditorSettings({
                        formatOnPaste: !editorSettings.formatOnPaste,
                      })
                    }
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>
              </div>

              {/* Format on Type */}
              <div className="settings-row">
                <label className="settings-label">Format on Type</label>
                <div className="settings-control">
                  <button
                    type="button"
                    className={`settings-toggle ${editorSettings.formatOnType ? "active" : ""}`}
                    onClick={() =>
                      updateEditorSettings({
                        formatOnType: !editorSettings.formatOnType,
                      })
                    }
                  >
                    <span className="toggle-thumb" />
                  </button>
                </div>
              </div>

              {/* Cursor Style */}
              <div className="settings-row">
                <label className="settings-label">Cursor Style</label>
                <div className="settings-control">
                  <SettingsDropdown
                    value={editorSettings.cursorStyle}
                    onChange={(v) =>
                      updateEditorSettings({
                        cursorStyle: v as "line" | "block" | "underline",
                      })
                    }
                    options={[
                      { label: "Line", value: "line" },
                      { label: "Block", value: "block" },
                      { label: "Underline", value: "underline" },
                    ]}
                    className="w-[100px]"
                  />
                </div>
              </div>

              {/* Execution Timeout */}
              <div className="settings-row">
                <label className="settings-label">
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    ⏱ Execution Timeout
                  </span>
                </label>
                <div className="settings-control">
                  <input
                    type="range"
                    min="5000"
                    max="60000"
                    step="5000"
                    value={editorSettings.executionTimeout}
                    onChange={(e) =>
                      updateEditorSettings({ executionTimeout: Number(e.target.value) })
                    }
                    className="settings-slider"
                  />
                  <span className="settings-value">
                    {editorSettings.executionTimeout / 1000}s
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB: Security & Vault ── */}
          {activeTab === "security" && (
            <div className="settings-tab-content">
              {/* Security info card */}
              <div className="settings-security-card">
                <div className="settings-security-card-header">
                  <ShieldCheck size={18} className="settings-security-card-icon" />
                  <div>
                    <div className="settings-security-card-title">
                      Automatic Transparent Encryption
                    </div>
                    <div className="settings-security-card-desc">
                      Tokens, passwords, custom headers, and secrets are encrypted with
                      AES-256-GCM before writing to storage. Decryption is transparent and instant.
                    </div>
                  </div>
                </div>
              </div>

              {/* Vault Status */}
              <div className="settings-row">
                <label className="settings-label">Protection Status</label>
                <div className="settings-control">
                  <span className="settings-vault-badge active">
                    <span className="settings-vault-dot active" />
                    Active & Encrypted
                  </span>
                </div>
              </div>

              {/* Encryption Algorithm */}
              <div className="settings-row">
                <label className="settings-label">Algorithm</label>
                <div className="settings-control">
                  <span className="settings-value">AES-256-GCM</span>
                </div>
              </div>

              {/* Key Derivation */}
              <div className="settings-row">
                <label className="settings-label">Key Source</label>
                <div className="settings-control">
                  <span className="settings-value">.env + Device Salt</span>
                </div>
              </div>

              {/* Derivation Rounds */}
              <div className="settings-row">
                <label className="settings-label">Key Derivation</label>
                <div className="settings-control">
                  <span className="settings-value">PBKDF2 (600k iter)</span>
                </div>
              </div>

              {/* Scope */}
              <div className="settings-row">
                <label className="settings-label">Storage Scope</label>
                <div className="settings-control">
                  <span className="settings-value">Client-Side Only</span>
                </div>
              </div>

              <div className="settings-divider" />

              {/* Storage Reset Action */}
              <div className="settings-row" style={{ alignItems: "center" }}>
                <div>
                  <div className="settings-label" style={{ color: "var(--text-1)" }}>
                    Reset Storage
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
                    Wipe credentials and rotate device key
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-action-btn danger"
                  onClick={() => setShowResetConfirm(true)}
                >
                  <Trash2 size={12} />
                  Reset
                </button>
              </div>

              {/* Reset Confirmation Subform */}
              {showResetConfirm && (
                <div className="settings-vault-subform danger-box">
                  <div className="settings-subform-title danger">
                    <AlertTriangle size={14} />
                    Confirm Storage Reset
                  </div>
                  <p className="settings-subform-warning">
                    This will wipe your device encryption key and delete all saved API tokens,
                    environment variables, and credentials stored in your browser. A fresh device
                    key will be generated automatically.
                  </p>
                  <div className="settings-subform-btns">
                    <button
                      type="button"
                      onClick={() => {
                        resetVault();
                        setShowResetConfirm(false);
                        toggleSettings();
                      }}
                      className="settings-subform-danger-btn"
                    >
                      Yes, Reset Storage
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowResetConfirm(false)}
                      className="settings-subform-cancel"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="settings-footer">
          <span className="settings-footer-hint">⌘K for Command Palette • ⌘, for Settings</span>
        </div>
      </div>
    </div>
  );
}
