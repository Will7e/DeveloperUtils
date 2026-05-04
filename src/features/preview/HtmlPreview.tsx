// ============================================================
// HTML Preview — Live iframe preview for HTML files
// ============================================================

import { useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app.store";
import { Globe } from "lucide-react";

export function HtmlPreview() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);

  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";

  useEffect(() => {
    if (isHtml && iframeRef.current && activeFile) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(activeFile.content);
        doc.close();
      }
    }
  }, [isHtml, activeFile?.content]);

  if (!isHtml) return null;

  return (
    <div className="html-preview">
      <div className="html-preview-header">
        <Globe className="h-3.5 w-3.5 text-primary" />
        <span>Live Preview</span>
      </div>
      <iframe
        ref={iframeRef}
        className="html-preview-frame"
        sandbox="allow-scripts allow-same-origin"
        title="HTML Preview"
      />
    </div>
  );
}
