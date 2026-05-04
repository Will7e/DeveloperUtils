// ============================================================
// Editor Tabs — File tabs above the editor
// ============================================================

import { X } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { cn } from "@/lib/utils";
import type { Language } from "@/types";

const tabIcons: Record<Language, string> = {
  javascript: "JS",
  typescript: "TS",
  python: "PY",
  html: "<>",
};

export function EditorTabs() {
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const deleteFile = useAppStore((s) => s.deleteFile);

  return (
    <div className="editor-tabs">
      <div className="editor-tabs-list">
        {files.map((file) => (
          <button
            key={file.id}
            className={cn(
              "editor-tab",
              file.id === activeFileId && "editor-tab-active"
            )}
            onClick={() => setActiveFile(file.id)}
          >
            <span className={cn("tab-lang-icon", `tab-lang-${file.language}`)}>
              {tabIcons[file.language]}
            </span>
            <span className="tab-name">{file.name}</span>
            {file.isDirty && <span className="tab-dirty" />}
            {files.length > 1 && (
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFile(file.id);
                }}
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
