// ============================================================
// Editor Tabs — File tabs with new-file dropdown
// ============================================================

import { useState, useRef, useEffect } from "react";
import { X, Plus } from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { LANGUAGE_CONFIGS } from "@/config";
import { cn } from "@/lib/utils";
import type { Language } from "@/types";

const tabIcons: Record<Language, string> = {
  javascript: "JS",
  typescript: "TS",
  python: "PY",
  html: "<>",
};

const langBadges: Record<Language, { cls: string; label: string }> = {
  javascript: { cls: "lang-badge-js", label: "JavaScript" },
  typescript: { cls: "lang-badge-ts", label: "TypeScript" },
  python: { cls: "lang-badge-py", label: "Python" },
  html: { cls: "lang-badge-html", label: "HTML" },
};

export function EditorTabs() {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const setActiveFile = useAppStore((s) => s.setActiveFile);
  const deleteFile = useAppStore((s) => s.deleteFile);
  const createFile = useAppStore((s) => s.createFile);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

  const handleToggleMenu = () => {
    if (!showMenu && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 2, left: rect.left });
    }
    setShowMenu(!showMenu);
  };

  const handleCreate = (lang: Language) => {
    const config = LANGUAGE_CONFIGS[lang];
    createFile(`untitled${config.extension}`, lang);
    setShowMenu(false);
  };

  return (
    <>
      <div className="tabs-bar">
        <div className="tabs-list">
          {files.map((file) => (
            <button
              key={file.id}
              className={cn("tab", file.id === activeFileId && "tab-active")}
              onClick={() => setActiveFile(file.id)}
            >
              <span className={cn("tab-icon", `tab-icon-${file.language}`)}>
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

        {/* New file button */}
        <button
          ref={btnRef}
          className="tab-new"
          onClick={handleToggleMenu}
          title="New File"
        >
          <Plus />
        </button>
      </div>

      {/* New file dropdown — rendered as fixed-position portal to avoid overflow clipping */}
      {showMenu && (
        <>
          <div className="dropdown-backdrop" onClick={() => setShowMenu(false)} />
          <div
            ref={menuRef}
            className="new-file-dropdown"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {(Object.keys(LANGUAGE_CONFIGS) as Language[]).map((lang) => (
              <button
                key={lang}
                className="new-file-option"
                onClick={() => handleCreate(lang)}
              >
                <span className={cn("lang-badge", langBadges[lang].cls)}>
                  {tabIcons[lang]}
                </span>
                <span>{langBadges[lang].label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
