import { useState, useEffect } from "react";
import { X, Download } from "lucide-react";
import { useApiTesterStore } from "@/stores/api-tester.store";

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExportModal({ isOpen, onClose }: ExportModalProps) {
  const tabs = useApiTesterStore((s) => s.tabs);
  const exportTabsAsZip = useApiTesterStore((s) => s.exportTabsAsZip);
  const [selectedTabs, setSelectedTabs] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      setSelectedTabs(tabs.map((t) => t.id));
    }
  }, [isOpen, tabs]);

  if (!isOpen) return null;

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

          <div className="api-export-actions">
            <button
              className="api-export-action-btn"
              onClick={() => setSelectedTabs(tabs.map((t) => t.id))}
            >
              Select All
            </button>
            <button
              className="api-export-action-btn"
              onClick={() => setSelectedTabs([])}
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
                  checked={selectedTabs.includes(tab.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedTabs([...selectedTabs, tab.id]);
                    } else {
                      setSelectedTabs(selectedTabs.filter((id) => id !== tab.id));
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
              await exportTabsAsZip(selectedTabs);
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
