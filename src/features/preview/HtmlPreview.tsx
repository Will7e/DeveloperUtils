// ============================================================
// HTML Preview — Full live preview panel for HTML files
// ============================================================

import { useEffect, useRef, useState } from "react";
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

  // Debounce the HTML content to avoid rapid iframe re-renders on every keystroke.
  // Uses srcdoc (W3C standard) instead of doc.open()/doc.write()/doc.close()
  // which caused race conditions and preview failures during active typing.
  const [debouncedContent, setDebouncedContent] = useState(activeFile?.content || "");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!isHtml) return;
    const timer = setTimeout(() => {
      setDebouncedContent(activeFile?.content || "");
    }, 300);
    return () => clearTimeout(timer);
  }, [isHtml, activeFile?.content]);

  const handleRefresh = () => {
    // Force a full iframe reload by bumping the key
    setDebouncedContent(activeFile?.content || "");
    setRefreshKey((k) => k + 1);
  };

  const handleOpenExternal = () => {
    if (!activeFile) return;
    // Inject strict sandbox CSP to ensure isolation from parent resources
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: data:; style-src 'unsafe-inline' https: data:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src *;">`;
    let content = activeFile.content;
    if (content.includes("<head>")) {
      content = content.replace("<head>", `<head>\n  ${cspMeta}`);
    } else {
      content = `${cspMeta}\n${content}`;
    }

    // Using a data: URL guarantees an opaque 'null' origin in modern browsers,
    // preventing any scripts in the preview from accessing InTab's localStorage, cookies, or same-origin APIs.
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(content)}`;
    window.open(dataUrl, "_blank", "noopener,noreferrer");
  };

  if (!isHtml) return null;

  return (
    <div className="html-preview">
      {/* Header */}
      <div className="html-preview-header">
        <div className="html-preview-header-left">
          <Globe style={{ width: 14, height: 14, color: "var(--accent)" }} />
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
                  color: viewMode === "mobile" ? "var(--accent)" : undefined,
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

      {/* Iframe container — uses srcdoc for safe, atomic content updates */}
      <div className="html-preview-body">
        <iframe
          key={refreshKey}
          ref={iframeRef}
          className="html-preview-frame"
          style={viewMode === "mobile" ? { maxWidth: 375, margin: "0 auto" } : undefined}
          sandbox="allow-scripts allow-modals"
          title="HTML Preview"
          srcDoc={debouncedContent}
        />
      </div>
    </div>
  );
}
