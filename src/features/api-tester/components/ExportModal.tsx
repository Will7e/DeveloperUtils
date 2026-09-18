import { useState } from "react";
import { X, Download, ShieldCheck } from "lucide-react";
import { useApiTesterStore } from "@/stores/api-tester.store";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExportModal({ isOpen, onClose }: ExportModalProps) {
  const tabs = useApiTesterStore((s) => s.tabs);
  const exportTabsAsZip = useApiTesterStore((s) => s.exportTabsAsZip);
  const [deselectedTabIds, setDeselectedTabIds] = useState<string[]>([]);
  const [sanitizeSecrets, setSanitizeSecrets] = useState(true);

  if (!isOpen) return null;

  const selectedTabs = tabs.filter((t) => !deselectedTabIds.includes(t.id)).map((t) => t.id);

  return (
    <div className="api-modal-overlay">
      <div className="api-modal-content">
        <div className="api-modal-header">
          <h3 className="api-modal-title">Export Tabs</h3>
          <button className="api-modal-close" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="api-modal-body">
          <p className="api-modal-desc">
            Select the tabs you want to export. They will be downloaded as a ZIP
            folder containing JSON files.
          </p>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              margin: "12px 0 14px",
              padding: "9px 12px",
              background: sanitizeSecrets ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
              border: `1px solid ${sanitizeSecrets ? "rgba(16, 185, 129, 0.25)" : "rgba(239, 68, 68, 0.25)"}`,
              borderRadius: "6px",
              transition: "all 0.15s ease",
            }}
          >
            <ShieldCheck
              className="h-4 w-4 shrink-0"
              style={{ color: sanitizeSecrets ? "#34d399" : "#f87171" }}
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                cursor: "pointer",
                fontSize: "12px",
                color: "var(--text-secondary)",
                userSelect: "none",
                flex: 1,
              }}
            >
              <input
                type="checkbox"
                className="api-checkbox"
                checked={sanitizeSecrets}
                onChange={(e) => setSanitizeSecrets(e.target.checked)}
              />
              <span>
                {sanitizeSecrets
                  ? "Sanitize sensitive credentials (passwords, tokens, keys) — Recommended"
                  : "Include sensitive raw credentials in export files (Warning: risk of leakage)"}
              </span>
            </label>
          </div>

          <div className="api-export-actions">
            <button
              className="api-export-action-btn"
              onClick={() => setDeselectedTabIds([])}
            >
              Select All
            </button>
            <button
              className="api-export-action-btn"
              onClick={() => setDeselectedTabIds(tabs.map((t) => t.id))}
            >
              Deselect All
            </button>
          </div>

          <div className="api-export-tab-list">
            {tabs.map((tab) => (
              <label key={tab.id} className="api-export-tab-item">
                <input
                  type="checkbox"
                  className="api-checkbox"
                  checked={!deselectedTabIds.includes(tab.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setDeselectedTabIds(deselectedTabIds.filter((id) => id !== tab.id));
                    } else {
                      setDeselectedTabIds([...deselectedTabIds, tab.id]);
                    }
                  }}
                />
                <span
                  className={`api-badge api-badge-${tab.method.toLowerCase()}`}
                  style={{ fontSize: "9px", width: "auto", padding: "2px 4px" }}
                >
                  {tab.method}
                </span>
                <span className="api-export-tab-name">{tab.name}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="api-modal-footer">
          <button className="api-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="api-send-btn"
            disabled={selectedTabs.length === 0}
            onClick={async () => {
              await exportTabsAsZip(selectedTabs, sanitizeSecrets);
              onClose();
            }}
            style={{ height: "32px", padding: "0 16px" }}
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export {selectedTabs.length} Tabs</span>
          </button>
        </div>
      </div>
    </div>
  );
}
