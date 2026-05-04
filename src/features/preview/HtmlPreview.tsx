// ============================================================
// HTML Preview — Full live preview panel for HTML files
// ============================================================

import { useEffect, useRef, useCallback, useState } from "react";
import { useAppStore } from "@/stores/app.store";
import { Globe, RefreshCw, ExternalLink, Smartphone, Monitor } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function HtmlPreview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const [viewMode, setViewMode] = useState<"desktop" | "mobile">("desktop");

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";

  const writeToIframe = useCallback(() => {
    if (iframeRef.current && activeFile) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(activeFile.content);
        doc.close();
      }
    }
  }, [activeFile?.content]);

  useEffect(() => {
    if (isHtml) {
      writeToIframe();
    }
  }, [isHtml, writeToIframe]);

  const handleRefresh = () => {
    writeToIframe();
  };

  const handleOpenExternal = () => {
    if (!activeFile) return;
    const blob = new Blob([activeFile.content], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  if (!isHtml) return null;

  return (
    <div className="html-preview">
      {/* Header */}
      <div className="html-preview-header">
        <div className="html-preview-header-left">
          <Globe style={{ width: 14, height: 14, color: "#0ea5e9" }} />
          <span className="html-preview-title">Live Preview</span>
          <span className="html-preview-badge">Auto</span>
        </div>
        <div className="html-preview-header-right">
          {/* Viewport toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={() => setViewMode(viewMode === "desktop" ? "mobile" : "desktop")}
                style={{
                  width: 24,
                  height: 24,
                  color: viewMode === "mobile" ? "#0ea5e9" : undefined,
                }}
              >
                {viewMode === "desktop" ? (
                  <Monitor style={{ width: 12, height: 12 }} />
                ) : (
                  <Smartphone style={{ width: 12, height: 12 }} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {viewMode === "desktop" ? "Switch to Mobile" : "Switch to Desktop"}
            </TooltipContent>
          </Tooltip>

          {/* Refresh */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={handleRefresh}
                style={{ width: 24, height: 24 }}
              >
                <RefreshCw style={{ width: 12, height: 12 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh Preview</TooltipContent>
          </Tooltip>

          {/* Open in new tab */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="toolbar-icon-btn"
                onClick={handleOpenExternal}
                style={{ width: 24, height: 24 }}
              >
                <ExternalLink style={{ width: 12, height: 12 }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Open in New Tab</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Iframe container */}
      <div className="html-preview-body">
        <iframe
          ref={iframeRef}
          className="html-preview-frame"
          style={viewMode === "mobile" ? { maxWidth: 375, margin: "0 auto" } : undefined}
          sandbox="allow-scripts allow-same-origin"
          title="HTML Preview"
        />
      </div>
    </div>
  );
}
