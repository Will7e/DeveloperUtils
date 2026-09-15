import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useAppStore } from "@/stores/app.store";
import {
  getExcalidrawLibraries, loadLibraryToExcalidraw,
  getExcalidrawLibraryPreviewUrl, getExcalidrawLibraryCdnPreviewUrl,
  type ExcalidrawLibraryItem,
} from "@/utils/excalidrawLibrary";

interface Props { isOpen: boolean; onClose: () => void; excalidrawAPI: ExcalidrawImperativeAPI | null; }

export function ExcalidrawLibraryModal({ isOpen, onClose, excalidrawAPI }: Props) {
  const [libs, setLibs] = useState<ExcalidrawLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const toast = useAppStore((s) => s.addToast);
  const storeIds = useAppStore((s) => s.excalidrawAddedLibraryIds || []);
  const storeAdd = useAppStore((s) => s.addExcalidrawAddedLibraryId);

  const isAdded = useCallback((id: string) => storeIds.includes(id) || added.has(id), [storeIds, added]);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      getExcalidrawLibraries().then((d) => { setLibs(d); setLoading(false); }).catch(() => setLoading(false));
    }
  }, [isOpen]);

  const handleAdd = async (lib: ExcalidrawLibraryItem) => {
    if (!excalidrawAPI || isAdded(lib.id)) return;
    try {
      setLoadingId(lib.id);
      const n = await loadLibraryToExcalidraw(lib.source, excalidrawAPI);
      setAdded((p) => new Set(p).add(lib.id));
      storeAdd(lib.id);
      toast({ message: `Added "${lib.name}" — ${n} shapes`, type: "success" });
    } catch {
      toast({ message: `Failed to load "${lib.name}"`, type: "error" });
    } finally {
      setLoadingId(null);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 99999, background: "rgba(0,0,0,0.5)", overflow: "auto", padding: 40 }}>
      <div style={{ background: "#1a1a2e", color: "#fff", maxWidth: 900, margin: "0 auto", padding: 20, borderRadius: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>Library ({libs.length} items)</h2>
          <button onClick={onClose}>✕ Close</button>
        </div>

        {loading ? <p>Loading...</p> : (
          <div>
            {libs.map((lib) => (
              <div key={lib.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", padding: "12px 0", display: "flex", gap: 12, alignItems: "flex-start" }}>
                <img
                  src={getExcalidrawLibraryPreviewUrl(lib.preview)}
                  alt={lib.name}
                  style={{ width: 80, height: 60, objectFit: "contain", background: "#fff", borderRadius: 4 }}
                  onError={(e) => { e.currentTarget.src = getExcalidrawLibraryCdnPreviewUrl(lib.preview); }}
                />
                <div style={{ flex: 1 }}>
                  <strong>{lib.name}</strong>
                  <div style={{ fontSize: 12, opacity: 0.5 }}>{lib.description}</div>
                  <div style={{ fontSize: 11, opacity: 0.4, marginTop: 2 }}>
                    by {lib.authors[0]?.name || "Unknown"} · v{lib.version || 1} · {lib.created}
                  </div>
                </div>
                <button onClick={() => handleAdd(lib)} disabled={loadingId === lib.id || isAdded(lib.id)}>
                  {loadingId === lib.id ? "Adding..." : isAdded(lib.id) ? "✓ Added" : "+ Add"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default ExcalidrawLibraryModal;
