// ============================================================
// Sidebar — File explorer & language selection
// ============================================================

import { useState } from "react";
import {
  FileCode,
  FileType,
  FilePlus,
  Trash2,
  X,
  Code2,
  Braces,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/stores/app.store";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";
import { cn } from "@/lib/utils";

const languageIcons: Record<Language, React.ReactNode> = {
  javascript: <span className="lang-icon lang-js">JS</span>,
  typescript: <span className="lang-icon lang-ts">TS</span>,
  python: <span className="lang-icon lang-py">PY</span>,
  html: <span className="lang-icon lang-html">{"<>"}</span>,
  json: <span className="lang-icon lang-json">{"{}"}</span>,
};

export function Sidebar() {
  const [showNewFile, setShowNewFile] = useState(false);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const createFile = useAppStore((s) => s.createFile);
  const deleteFile = useAppStore((s) => s.deleteFile);
  const renameFile = useAppStore((s) => s.renameFile);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  if (!sidebarOpen) return null;

  const handleCreateFile = (language: Language) => {
    const config = LANGUAGE_CONFIGS[language];
    createFile(`untitled${config.extension}`, language);
    setShowNewFile(false);
  };

  return (
    <div className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-header-title">
          <Code2 className="h-4 w-4 text-primary" />
          <span>Explorer</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowNewFile(!showNewFile)}
              className="h-6 w-6"
            >
              <FilePlus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New File</TooltipContent>
        </Tooltip>
      </div>

      {/* New file dropdown */}
      {showNewFile && (
        <div className="new-file-menu">
          <div className="new-file-title">Select language:</div>
          {(Object.keys(LANGUAGE_CONFIGS) as Language[]).map((lang) => (
            <button
              key={lang}
              className="new-file-option"
              onClick={() => handleCreateFile(lang)}
            >
              {languageIcons[lang]}
              <span>{LANGUAGE_CONFIGS[lang].label}</span>
            </button>
          ))}
        </div>
      )}

      <Separator className="opacity-50" />

      {/* File list */}
      <ScrollArea className="flex-1">
        <div className="sidebar-files">
          {files.map((file) => (
            <div
              key={file.id}
              className={cn(
                "sidebar-file",
                file.id === activeFileId && "sidebar-file-active"
              )}
              onClick={() => setActiveFile(file.id)}
              onDoubleClick={() => {
                setRenamingId(file.id);
                setRenameValue(file.name);
              }}
            >
              <div className="sidebar-file-info">
                {languageIcons[file.language]}
                {renamingId === file.id ? (
                  <input
                    autoFocus
                    className="sidebar-file-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      if (renameValue.trim() && renameValue !== file.name) {
                        renameFile(file.id, renameValue.trim());
                      }
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (renameValue.trim() && renameValue !== file.name) {
                          renameFile(file.id, renameValue.trim());
                        }
                        setRenamingId(null);
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="sidebar-file-name">
                    {file.name}
                    {file.isDirty && <span className="dirty-dot" />}
                  </span>
                )}
              </div>
              <div className="sidebar-file-actions">
                <button
                  className="sidebar-file-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(file.id);
                    setRenameValue(file.name);
                  }}
                  title="Rename"
                >
                  <FileType className="h-3 w-3" />
                </button>
                {files.length > 1 && (
                  <button
                    className="sidebar-file-action-btn sidebar-file-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFile(file.id);
                    }}
                    title="Delete"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Language info */}
      <div className="sidebar-footer">
        <Separator className="opacity-50" />
        <div className="sidebar-languages">
          <div className="sidebar-lang-title">Supported</div>
          <div className="sidebar-lang-grid">
            {(Object.keys(LANGUAGE_CONFIGS) as Language[]).map((lang) => (
              <Tooltip key={lang}>
                <TooltipTrigger asChild>
                  <button
                    className="sidebar-lang-chip"
                    onClick={() => handleCreateFile(lang)}
                  >
                    {languageIcons[lang]}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  New {LANGUAGE_CONFIGS[lang].label} file
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
