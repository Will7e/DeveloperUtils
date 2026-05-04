// ============================================================
// Settings Panel — Editor configuration overlay
// ============================================================

import { X, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAppStore } from "@/stores/app.store";

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
            <Monitor className="h-4 w-4 text-primary" />
            <span>Editor Settings</span>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={toggleSettings}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Separator className="opacity-30" />

        <div className="settings-body">
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
        </div>
      </div>
    </div>
  );
}
