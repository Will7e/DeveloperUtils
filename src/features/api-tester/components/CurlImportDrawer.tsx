import { useState } from "react";
import { Terminal } from "lucide-react";

interface CurlImportDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (curlString: string) => boolean;
}

export function CurlImportDrawer({
  isOpen,
  onClose,
  onImport,
}: CurlImportDrawerProps) {
  const [curlImportValue, setCurlImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const handleClose = () => {
    onClose();
    setImportError(null);
    setCurlImportValue("");
  };

  const handleClear = () => {
    setCurlImportValue("");
    setImportError(null);
  };

  const handleSubmit = () => {
    if (!curlImportValue.trim()) {
      setImportError("Please paste a valid cURL command.");
      return;
    }
    const success = onImport(curlImportValue);
    if (success) {
      setImportSuccess(true);
      setImportError(null);
      setTimeout(() => {
        setImportSuccess(false);
        onClose();
        setCurlImportValue("");
      }, 1200);
    } else {
      setImportError(
        "Failed to parse cURL. Ensure command begins with 'curl' and contains a valid URL."
      );
    }
  };

  return (
    <div className="api-import-curl-wrapper" data-open={isOpen}>
      <div className="api-import-curl-wrapper-inner">
        <div className="api-import-curl-panel">
          <div className="api-import-curl-header">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Terminal className="h-4 w-4 text-accent" />
              <span className="api-import-curl-title">Import Request from cURL</span>
            </div>
            <button
              type="button"
              className="api-import-close-btn"
              onClick={handleClose}
              title="Close"
            >
              &times;
            </button>
          </div>
          <textarea
            className="api-import-curl-textarea"
            placeholder={`Paste raw cURL command (e.g. curl -X POST 'https://api.example.com' -H 'Content-Type: application/json' -d '{"status": "ok"}')`}
            value={curlImportValue}
            onChange={(e) => {
              setCurlImportValue(e.target.value);
              setImportError(null);
            }}
          />
          <div className="api-import-curl-actions">
            {importError && (
              <span className="api-import-curl-error">{importError}</span>
            )}
            {importSuccess && (
              <span className="api-import-curl-success">
                Request imported successfully!
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="api-clear-btn"
              onClick={handleClear}
              style={{ padding: "6px 12px" }}
            >
              Clear
            </button>
            <button
              type="button"
              className="api-import-submit-btn"
              onClick={handleSubmit}
            >
              Import Request
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
