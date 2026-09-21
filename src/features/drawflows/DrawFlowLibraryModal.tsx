import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { CardsSkeleton } from "@/components/ui/skeleton";
import { useAppStore } from "@/stores/app.store";
import {
  getDrawFlowLibraries,
  loadLibraryToDrawFlow,
  removeLibraryFromDrawFlow,
  getDrawFlowLibraryPreviewUrl,
  getDrawFlowLibraryCdnPreviewUrl,
  type DrawFlowLibraryItem,
} from "@/utils/drawflowLibrary";
import { X, Search, Plus, Loader2, Boxes, Trash2 } from "lucide-react";

interface Props { 
  isOpen: boolean; 
  onClose: () => void; 
  canvasAPI: ExcalidrawImperativeAPI | null; 
}

export function DrawFlowLibraryModal({ isOpen, onClose, canvasAPI }: Props) {
  const [libs, setLibs] = useState<DrawFlowLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const toast = useAppStore((s) => s.addToast);
  const storeIds = useAppStore((s) => s.drawflowAddedLibraryIds || s.excalidrawAddedLibraryIds || []);
  const storeAdd = useAppStore((s) => s.addDrawFlowAddedLibraryId || s.addExcalidrawAddedLibraryId);
  const storeRemove = useAppStore((s) => s.removeDrawFlowAddedLibraryId || s.removeExcalidrawAddedLibraryId);

  const isAdded = useCallback((id: string) => storeIds.includes(id) || added.has(id), [storeIds, added]);

  useEffect(() => {
    if (isOpen) {
      // Reset local session state; store is the source of truth.
      // Deferred so setState happens outside the effect body
      // (avoids cascading renders on effect flush).
      const timer = setTimeout(() => {
        setAdded(new Set());
        setLoading(true);
        getDrawFlowLibraries().then((d) => {
          setLibs(d);
          setLoading(false);
        }).catch(() => setLoading(false));
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const filteredLibs = useMemo(() => {
    if (!search.trim()) return libs;
    const q = search.toLowerCase().trim();
    return libs.filter((lib) => 
      lib.name.toLowerCase().includes(q) || 
      lib.description.toLowerCase().includes(q) ||
      lib.authors.some((a) => a.name.toLowerCase().includes(q))
    );
  }, [libs, search]);

  const handleAdd = async (lib: DrawFlowLibraryItem) => {
    if (!canvasAPI || isAdded(lib.id)) return;
    try {
      setLoadingId(lib.id);
      const n = await loadLibraryToDrawFlow(lib.source, canvasAPI, lib.id);
      setAdded((p) => new Set(p).add(lib.id));
      if (storeAdd) storeAdd(lib.id);
      toast({ message: `Added "${lib.name}" (${n} shapes) to canvas`, type: "success" });
    } catch {
      toast({ message: `Failed to load "${lib.name}"`, type: "error" });
    } finally {
      setLoadingId(null);
    }
  };

  const handleRemove = async (lib: DrawFlowLibraryItem) => {
    if (!canvasAPI || !isAdded(lib.id)) return;
    try {
      setRemovingId(lib.id);
      const n = await removeLibraryFromDrawFlow(lib.source, canvasAPI, lib.id);
      setAdded((p) => { const next = new Set(p); next.delete(lib.id); return next; });
      if (storeRemove) storeRemove(lib.id);
      toast({ message: `Removed "${lib.name}" (${n} shapes) from canvas`, type: "success" });
    } catch {
      toast({ message: `Failed to remove "${lib.name}"`, type: "error" });
    } finally {
      setRemovingId(null);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="lib-modal-overlay" onClick={onClose}>
      <div className="lib-modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="lib-modal-header">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/25 flex items-center justify-center text-accent">
              <Boxes className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-text-1">DrawFlow Libraries</h2>
              <p className="text-[11px] text-text-3">Browse and add community component packs directly to your canvas</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Search Input */}
            <div className="lib-search-container" style={{ width: "220px" }}>
              <Search className="lib-search-icon" />
              <input
                type="text"
                placeholder="Filter collections..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="lib-search-input"
              />
            </div>

            <button 
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="lib-modal-body">
          {loading ? (
            <CardsSkeleton count={4} />
          ) : filteredLibs.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <Boxes className="w-10 h-10 text-text-3 opacity-30 mb-2" />
              <p className="text-sm font-semibold text-text-2">No libraries found</p>
              <p className="text-xs text-text-3 mt-1">Try another search term.</p>
            </div>
          ) : (
            <div className="lib-excal-grid">
              {filteredLibs.map((lib) => {
                const addedItem = isAdded(lib.id);
                const isLoading = loadingId === lib.id;

                return (
                  <ModalDrawFlowCard
                    key={lib.id}
                    lib={lib}
                    isAdded={addedItem}
                    isLoading={isLoading}
                    isRemoving={removingId === lib.id}
                    onAdd={() => handleAdd(lib)}
                    onRemove={() => handleRemove(lib)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModalDrawFlowCard({
  lib,
  isAdded,
  isLoading,
  isRemoving,
  onAdd,
  onRemove,
}: {
  lib: DrawFlowLibraryItem;
  isAdded: boolean;
  isLoading: boolean;
  isRemoving: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const [triedCdn, setTriedCdn] = useState(false);

  const previewUrl = getDrawFlowLibraryPreviewUrl(lib.preview);
  const cdnPreviewUrl = getDrawFlowLibraryCdnPreviewUrl(lib.preview);

  return (
    <div className="lib-excal-card">
      <div className="lib-excal-preview-wrap">
        {!imgError ? (
          <img
            src={triedCdn ? cdnPreviewUrl : previewUrl}
            alt={lib.name}
            className="lib-excal-preview-img"
            loading="lazy"
            onError={() => {
              if (!triedCdn) {
                setTriedCdn(true);
              } else {
                setImgError(true);
              }
            }}
          />
        ) : (
          <div className="lib-excal-preview-fallback">
            <Boxes className="w-6 h-6 opacity-30" />
            <span>Preview unavailable</span>
          </div>
        )}
      </div>

      <div className="lib-excal-body">
        <h3 className="lib-excal-name" title={lib.name}>{lib.name}</h3>
        <p className="lib-excal-desc" title={lib.description}>{lib.description || "Collection of diagram elements."}</p>

        <div className="lib-excal-footer">
          <div className="lib-excal-meta">
            <span className="lib-excal-author" title={lib.authors[0]?.name || "Community"}>
              by {lib.authors[0]?.name || "Community"}
            </span>
            <span>v{lib.version || 1}</span>
          </div>

          <button
              className={`lib-excal-action-btn ${isAdded ? "lib-excal-action-btn-remove" : ""}`}
              onClick={isAdded ? onRemove : onAdd}
              disabled={isLoading || isRemoving}
              title={isAdded ? `Remove "${lib.name}" from canvas` : `Add "${lib.name}" to canvas`}
            >
              {isLoading ? (
                <><Loader2 className="w-3 h-3 animate-spin" /><span>Adding...</span></>
              ) : isRemoving ? (
                <><Loader2 className="w-3 h-3 animate-spin" /><span>Removing...</span></>
              ) : isAdded ? (
                <><Trash2 className="w-3 h-3" /><span>Remove</span></>
              ) : (
                <><Plus className="w-3 h-3" /><span>Add</span></>
              )}
            </button>
        </div>
      </div>
    </div>
  );
}

export const ExcalidrawLibraryModal = DrawFlowLibraryModal;
export default DrawFlowLibraryModal;
