// ============================================================
// Sidebar — Compiler file explorer (chat-sidebar design language)
// ============================================================
// Follows the Geist design system patterns established by the chat
// sidebar: sans-serif header with ghost icon buttons, search field,
// rounded rows with hover-revealed actions, two-step delete, and a
// slim accent pin-dot for the active file. Collapses to a compact
// icon rail with the same visual treatment.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  FilePlus2,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { LANGUAGE_CONFIGS } from "@/config";
import type { Language } from "@/types";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { LanguageIcon } from "@/features/editor/language-icon";
import { NewFileMenu } from "@/features/editor/NewFileMenu";

/** Files matching the search query (name only — contents can be huge) */
function filterFiles(
  files: { id: string; name: string }[],
  query: string
): { id: string; name: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return files;
  return files.filter((f) => f.name.toLowerCase().includes(q));
}

export function Sidebar() {
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const createFile = useAppStore((s) => s.createFile);
  const deleteFile = useAppStore((s) => s.deleteFile);
  const duplicateFile = useAppStore((s) => s.duplicateFile);
  const renameFile = useAppStore((s) => s.renameFile);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const newFileBtnRef = useRef<HTMLButtonElement>(null);
  const newFileRailRef = useRef<HTMLButtonElement>(null);

  const isCollapsed = !sidebarOpen;

  // Disarm a pending delete when the target changes or after a delay,
  // so the armed state never goes stale (same as chat sidebar).
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteId]);

  const visibleFiles = useMemo(() => filterFiles(files, query), [files, query]);

  const handleCreateFile = (language: Language) => {
    const config = LANGUAGE_CONFIGS[language];
    createFile(`untitled${config.extension}`, language);
  };

  const openMenuFrom = (rect: DOMRect | null) => {
    if (!rect) return;
    setMenuAnchor({ top: rect.bottom + 6, left: rect.left });
    setMenuOpen(true);
  };

  const startRename = (fileId: string, name: string) => {
    setRenamingId(fileId);
    setRenameValue(name);
    setConfirmDeleteId(null);
  };

  const commitRename = () => {
    if (renamingId && renameValue.trim() && renameValue.trim() !== files.find((f) => f.id === renamingId)?.name) {
      renameFile(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleDelete = (id: string) => {
    if (confirmDeleteId === id) {
      deleteFile(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
    }
  };

  return (
    <>
      <div className={cn("sidebar", isCollapsed && "sidebar-collapsed")}>
        {/* ── Header ─────────────────────────────────────── */}
        <div className="sidebar-header">
          {isCollapsed ? (
            <div className="sidebar-header-rail">
              <SimpleTooltip content="Expand explorer" side="right">
                <button
                  type="button"
                  className="sidebar-icon-btn"
                  onClick={toggleSidebar}
                  aria-label="Expand explorer"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              </SimpleTooltip>
              <SimpleTooltip content="New file" side="right">
                <button
                  ref={newFileRailRef}
                  type="button"
                  className="sidebar-icon-btn"
                  onClick={() => openMenuFrom(newFileRailRef.current?.getBoundingClientRect() ?? null)}
                  aria-label="New file"
                >
                  <FilePlus2 className="h-4 w-4" />
                </button>
              </SimpleTooltip>
            </div>
          ) : (
            <>
              <div className="sidebar-title">
                <FolderOpen className="h-4 w-4" />
                <span>Explorer</span>
              </div>
              <div className="sidebar-header-actions">
                <SimpleTooltip content="New file" side="bottom">
                  <button
                    ref={newFileBtnRef}
                    type="button"
                    className="sidebar-icon-btn"
                    onClick={() => openMenuFrom(newFileBtnRef.current?.getBoundingClientRect() ?? null)}
                    aria-label="New file"
                  >
                    <FilePlus2 className="h-4 w-4" />
                  </button>
                </SimpleTooltip>
                <SimpleTooltip content="Collapse explorer" side="bottom">
                  <button
                    type="button"
                    className="sidebar-icon-btn"
                    onClick={toggleSidebar}
                    aria-label="Collapse explorer"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </SimpleTooltip>
              </div>
            </>
          )}
        </div>

        {/* ── Search (expanded only) ─────────────────────── */}
        {!isCollapsed && files.length > 0 && (
          <div className="sidebar-search">
            <Search className="h-3.5 w-3.5 sidebar-search-icon" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files…"
              className="sidebar-search-input"
              spellCheck={false}
            />
            {query && (
              <button
                type="button"
                className="sidebar-search-clear"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* ── File list (expanded) ───────────────────────── */}
        {!isCollapsed && (
          <div className="sidebar-list">
            {files.length === 0 ? (
              <div className="sidebar-empty">No files yet — create one!</div>
            ) : visibleFiles.length === 0 ? (
              <div className="sidebar-empty">
                No files match <strong>“{query}”</strong>
              </div>
            ) : (
              visibleFiles.map((file) => {
                const isActive = file.id === activeFileId;
                const isRenaming = file.id === renamingId;
                const isConfirmingDelete = file.id === confirmDeleteId;

                return (
                  <div
                    key={file.id}
                    className={cn("sidebar-file", isActive && "sidebar-file-active")}
                    onClick={() => !isRenaming && setActiveFile(file.id)}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? "true" : undefined}
                    onKeyDown={(e) => {
                      if (isRenaming) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setActiveFile(file.id);
                      }
                    }}
                  >
                    {isRenaming ? (
                      <div className="sidebar-file-rename">
                        <input
                          type="text"
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          onBlur={commitRename}
                          onClick={(e) => e.stopPropagation()}
                          className="sidebar-file-rename-input"
                          aria-label="File name"
                        />
                        <button
                          type="button"
                          className="sidebar-file-action"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            commitRename();
                          }}
                          aria-label="Confirm rename"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="sidebar-file-content">
                          <div className="sidebar-file-top">
                            <span className="sidebar-file-name">{file.name}</span>
                            {(file as { isDirty?: boolean }).isDirty && <span className="sidebar-file-dirty" aria-label="Unsaved changes" />}
                          </div>
                        </div>
                        <div className="sidebar-file-actions">
                          <SimpleTooltip content="Rename" side="top">
                            <button
                              type="button"
                              className="sidebar-file-action"
                              onClick={(e) => {
                                e.stopPropagation();
                                startRename(file.id, file.name);
                              }}
                              aria-label="Rename file"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </SimpleTooltip>
                          <SimpleTooltip content="Duplicate" side="top">
                            <button
                              type="button"
                              className="sidebar-file-action"
                              onClick={(e) => {
                                e.stopPropagation();
                                duplicateFile(file.id);
                              }}
                              aria-label="Duplicate file"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </SimpleTooltip>
                          <SimpleTooltip
                            content={isConfirmingDelete ? "Click again to delete" : "Delete"}
                            side="top"
                          >
                            <button
                              type="button"
                              className={cn(
                                "sidebar-file-action sidebar-file-action-danger",
                                isConfirmingDelete && "sidebar-file-action-confirm"
                              )}
                              onMouseLeave={() =>
                                setConfirmDeleteId((id) => (id === file.id ? null : id))
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(file.id);
                              }}
                              aria-label={
                                isConfirmingDelete
                                  ? "Click again to confirm delete"
                                  : "Delete file"
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </SimpleTooltip>
                        </div>
                        {isActive && <span className="sidebar-file-pin" />}
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── Collapsed file rail ────────────────────────── */}
        {isCollapsed && (
          <div className="sidebar-rail-files">
            {files.map((file) => (
              <SimpleTooltip key={file.id} content={file.name} side="right">
                <button
                  className={cn(
                    "sidebar-rail-file",
                    file.id === activeFileId && "sidebar-rail-file-active"
                  )}
                  onClick={() => setActiveFile(file.id)}
                  type="button"
                  aria-label={file.name}
                  aria-current={file.id === activeFileId ? "true" : undefined}
                >
                  <LanguageIcon language={file.language} size="sm" />
                </button>
              </SimpleTooltip>
            ))}
          </div>
        )}
      </div>

      {/* Shared language-picker popover (anchored to the invoking button) */}
      <NewFileMenu
        open={menuOpen}
        anchor={menuAnchor}
        onClose={() => setMenuOpen(false)}
        onCreate={handleCreateFile}
      />
    </>
  );
}
