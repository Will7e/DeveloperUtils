// ============================================================
// Settings Panel — Editor configuration overlay
// ============================================================

import { X, Settings, Volume2, VolumeX } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { 
  Tooltip, 
  TooltipTrigger, 
  TooltipContent 
} from "@/components/ui/tooltip";

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
            <Settings style={{ width: 15, height: 15, color: "#0ea5e9" }} />
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
              <select
                value={editorSettings.tabSize}
                onChange={(e) =>
                  updateEditorSettings({ tabSize: Number(e.target.value) })
                }
                className="settings-select"
              >
                <option value="2">2 spaces</option>
                <option value="4">4 spaces</option>
                <option value="8">8 spaces</option>
              </select>
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
              <select
                value={editorSettings.lineNumbers}
                onChange={(e) =>
                  updateEditorSettings({
                    lineNumbers: e.target.value as "on" | "off" | "relative",
                  })
                }
                className="settings-select"
              >
                <option value="on">On</option>
                <option value="off">Off</option>
                <option value="relative">Relative</option>
              </select>
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

          {/* Sound Effects */}
          <div className="settings-row">
            <label className="settings-label">
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {editorSettings.soundEffects ? (
                  <Volume2 style={{ width: 13, height: 13, color: "#0ea5e9" }} />
                ) : (
                  <VolumeX style={{ width: 13, height: 13, opacity: 0.4 }} />
                )}
                Sound Effects
              </span>
            </label>
            <div className="settings-control">
              <button
                className={`settings-toggle ${editorSettings.soundEffects ? "active" : ""}`}
                onClick={() =>
                  updateEditorSettings({
                    soundEffects: !editorSettings.soundEffects,
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
              <select
                value={editorSettings.cursorStyle}
                onChange={(e) =>
                  updateEditorSettings({
                    cursorStyle: e.target.value as "line" | "block" | "underline",
                  })
                }
                className="settings-select"
              >
                <option value="line">Line</option>
                <option value="block">Block</option>
                <option value="underline">Underline</option>
              </select>
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
