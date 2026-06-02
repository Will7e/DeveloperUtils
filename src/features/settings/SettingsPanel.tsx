// ============================================================
// Settings Panel — Editor configuration overlay
// ============================================================

import { X, Settings, Sun, Moon, ChevronDown } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { 
  Tooltip, 
  TooltipTrigger, 
  TooltipContent 
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SettingsDropdownProps {
  value: string | number;
  options: { label: string; value: string | number }[];
  onChange: (value: any) => void;
  className?: string;
}

function SettingsDropdown({ value, options, onChange, className = "w-[120px]" }: SettingsDropdownProps) {
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
    <TooltipTrigger asChild>
      {children}
    </TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

export function SettingsPanel() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const editorSettings = useAppStore((s) => s.editorSettings);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);

  if (!settingsOpen) return null;

  return (
    <div className="settings-overlay" onClick={toggleSettings}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
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

        <div className="settings-body">
          {/* Section: Editor */}
          <div className="settings-section-title">Editor</div>

          {/* Font Family */}
          <div className="settings-row">
            <label className="settings-label">Font Family</label>
            <div className="settings-control">
              <SettingsDropdown
                value={editorSettings.fontFamily}
                onChange={(v) => updateEditorSettings({ fontFamily: v })}
                options={[
                  { label: "Monospace", value: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" },
                  { label: "System UI", value: "system-ui, sans-serif" },
                  { label: "Courier", value: "'Courier New', Courier, monospace" }
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
                  { label: "8 spaces", value: 8 }
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
                onChange={(v) => updateEditorSettings({ lineNumbers: v as any })}
                options={[
                  { label: "On", value: "on" },
                  { label: "Off", value: "off" },
                  { label: "Relative", value: "relative" }
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

          {/* Section: Experience */}
          <div className="settings-section-title" style={{ marginTop: 8 }}>
            Experience
          </div>

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
                className={`settings-toggle ${editorSettings.theme === "light" ? "active" : ""}`}
                onClick={() =>
                  updateEditorSettings({
                    theme: editorSettings.theme === "dark" ? "light" : "dark",
                  })
                }
              >
                <span className="toggle-thumb" />
              </button>
              <span className="settings-value" style={{ textTransform: "capitalize" }}>{editorSettings.theme}</span>
            </div>
          </div>

          {/* Format on Paste */}
          <div className="settings-row">
            <label className="settings-label">Format on Paste</label>
            <div className="settings-control">
              <button
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
                onChange={(v) => updateEditorSettings({ cursorStyle: v as any })}
                options={[
                  { label: "Line", value: "line" },
                  { label: "Block", value: "block" },
                  { label: "Underline", value: "underline" }
                ]}
                className="w-[100px]"
              />
            </div>
          </div>

          {/* Section: Execution */}
          <div className="settings-section-title" style={{ marginTop: 8 }}>
            Execution
          </div>

          {/* Execution Timeout */}
          <div className="settings-row">
            <label className="settings-label">
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                ⏱ Timeout
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
              <span className="settings-value">{editorSettings.executionTimeout / 1000}s</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="settings-footer">
          <span className="settings-footer-hint">⌘K for Command Palette</span>
        </div>
      </div>
    </div>
  );
}
