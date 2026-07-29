// ============================================================
// ExcalidrawLibraryModal — Browse & Add Community Libraries
// ============================================================

import React, { useState, useEffect, useMemo } from "react";
import { Search, Library, Plus, Check, Loader2, X, ExternalLink, Sparkles, LayoutGrid } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAppStore } from "@/stores/app.store";
import {
  getExcalidrawLibraries,
  loadLibraryToExcalidraw,
  getExcalidrawLibraryPreviewUrl,
  getExcalidrawLibraryCdnPreviewUrl,
  type ExcalidrawLibraryItem,
} from "@/utils/excalidrawLibrary";

interface ExcalidrawLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}

const CATEGORIES = [
  { id: "all", label: "All Libraries" },
  { id: "system", label: "System Design", keywords: ["system", "architecture", "cloud", "aws", "gcp", "azure", "kubernetes", "docker", "snowflake"] },
  { id: "ui", label: "UI & Wireframes", keywords: ["ui", "wireframe", "mobile", "android", "ios", "gadget", "component", "design"] },
  { id: "icons", label: "Icons & Logos", keywords: ["icon", "logo", "brand", "dev", "tech"] },
  { id: "diagrams", label: "Flowcharts & Diagrams", keywords: ["flowchart", "diagram", "process", "map", "mindmap", "tree", "chart"] },
];

export function ExcalidrawLibraryModal({ isOpen, onClose, excalidrawAPI }: ExcalidrawLibraryModalProps) {
  const [libraries, setLibraries] = useState<ExcalidrawLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [loadingLibId, setLoadingLibId] = useState<string | null>(null);
  const [addedLibIds, setAddedLibIds] = useState<Set<string>>(new Set());

  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      getExcalidrawLibraries().then((data) => {
        setLibraries(data);
        setLoading(false);
      });
    }
  }, [isOpen]);

  const filteredLibraries = useMemo(() => {
    return libraries.filter((lib) => {
      // Category filter
      if (activeCategory !== "all") {
        const cat = CATEGORIES.find((c) => c.id === activeCategory);
        if (cat?.keywords) {
          const matchCat = cat.keywords.some((kw) =>
            lib.name.toLowerCase().includes(kw) || lib.description.toLowerCase().includes(kw)
          );
          if (!matchCat) return false;
        }
      }

      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchName = lib.name.toLowerCase().includes(q);
        const matchDesc = lib.description.toLowerCase().includes(q);
        const matchAuthor = lib.authors.some((a) => a.name.toLowerCase().includes(q));
        return matchName || matchDesc || matchAuthor;
      }

      return true;
    });
  }, [libraries, activeCategory, searchQuery]);

  const handleAddLibrary = async (lib: ExcalidrawLibraryItem) => {
    if (!excalidrawAPI) {
      addToast({ message: "Excalidraw canvas is not ready", type: "error" });
      return;
    }

    try {
      setLoadingLibId(lib.id);
      const count = await loadLibraryToExcalidraw(lib.source, excalidrawAPI);
      setAddedLibIds((prev) => new Set(prev).add(lib.id));
      addToast({ message: `Added "${lib.name}" (${count} items) to Excalidraw Library!`, type: "success" });
    } catch (err) {
      console.error(err);
      addToast({ message: `Failed to load "${lib.name}"`, type: "error" });
    } finally {
      setLoadingLibId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-5xl h-[85vh] bg-bg-1 border border-border/60 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 border-b border-border/40 bg-bg-2/50 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-accent/10 text-accent">
              <Library className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-text-0 flex items-center gap-2">
                Excalidraw Community Libraries
                <span className="text-xs px-2 py-0.5 rounded-full bg-accent/15 text-accent font-medium">
                  {libraries.length} Available
                </span>
              </h2>
              <p className="text-xs text-text-2">
                Browse, search, and download official Excalidraw library shapes directly into your workspace.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-2 hover:text-text-0 hover:bg-bg-3 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Toolbar: Search & Category Pills */}
        <div className="px-4 py-3 border-b border-border/30 bg-bg-1 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-2" />
            <input
              type="text"
              placeholder="Search libraries (System Design, AWS, Icons, Flowcharts...)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 text-xs bg-bg-2 border border-border/50 rounded-lg text-text-0 placeholder:text-text-3 focus:outline-none focus:border-accent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-3 hover:text-text-1"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto py-0.5">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`text-xs px-3 py-1 rounded-md transition-colors whitespace-nowrap ${activeCategory === cat.id
                  ? "bg-accent text-white font-medium"
                  : "bg-bg-2 text-text-2 hover:text-text-0 hover:bg-bg-3"
                  }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Library Grid Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="h-full flex flex-col items-center justify-center text-text-2 gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-accent" />
              <span className="text-xs">Loading library catalog...</span>
            </div>
          ) : filteredLibraries.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-text-3 py-12 gap-2">
              <LayoutGrid className="w-10 h-10 stroke-1" />
              <p className="text-sm font-medium text-text-2">No libraries found</p>
              <p className="text-xs">Try adjusting your search filter or category selection.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredLibraries.map((lib) => {
                const isAdded = addedLibIds.has(lib.id);
                const isLoadingThis = loadingLibId === lib.id;
                const previewUrl = getExcalidrawLibraryPreviewUrl(lib.preview);
                const cdnPreviewUrl = getExcalidrawLibraryCdnPreviewUrl(lib.preview);

                return (
                  <div
                    key={lib.id}
                    className="group bg-bg-2/70 border border-border/40 hover:border-accent/40 rounded-lg p-3 flex flex-col justify-between transition-all hover:shadow-md hover:bg-bg-2"
                  >
                    <div>
                      {/* Image Preview Container */}
                      <div className="w-full h-28 rounded-md bg-bg-0/60 border border-border/20 overflow-hidden flex items-center justify-center mb-2.5 relative group-hover:bg-bg-0 transition-colors">
                        <img
                          src={previewUrl}
                          alt={lib.name}
                          className="max-h-full max-w-full object-contain p-2 filter dark:invert-[0.1]"
                          onError={(e) => {
                            const img = e.currentTarget;
                            if (img.src !== cdnPreviewUrl) {
                              img.src = cdnPreviewUrl;
                            } else {
                              img.style.display = "none";
                            }
                          }}
                        />
                      </div>

                      <h3 className="text-xs font-semibold text-text-0 line-clamp-1 group-hover:text-accent transition-colors">
                        {lib.name}
                      </h3>
                      <p className="text-[11px] text-text-2 line-clamp-2 my-1 min-h-[32px]">
                        {lib.description}
                      </p>

                      {/* Author Info */}
                      {lib.authors.length > 0 && (
                        <div className="text-[10px] text-text-3 mb-3 flex items-center gap-1">
                          <span>by</span>
                          <a
                            href={lib.authors[0]!.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-text-2 hover:text-accent underline flex items-center gap-0.5 truncate max-w-[140px]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {lib.authors[0]!.name}
                            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Action Button */}
                    <button
                      onClick={() => handleAddLibrary(lib)}
                      disabled={isLoadingThis}
                      className={`w-full py-1.5 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${isAdded
                        ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                        : "bg-accent hover:bg-accent/90 text-white shadow-sm"
                        }`}
                    >
                      {isLoadingThis ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Downloading...</span>
                        </>
                      ) : isAdded ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Added to Library</span>
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add to Excalidraw</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
