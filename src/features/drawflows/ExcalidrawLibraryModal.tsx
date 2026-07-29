// ============================================================
// ExcalidrawLibraryModal — Browse & Add Community Libraries
// ============================================================

import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  Library,
  Plus,
  Check,
  Loader2,
  X,
  Sparkles,
  LayoutGrid,
  Layers,
  Compass,
  ArrowUpRight,
  RotateCcw,
} from "lucide-react";
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
  { id: "all", label: "All Collections", icon: LayoutGrid },
  { id: "system", label: "System Architecture", keywords: ["system", "architecture", "cloud", "aws", "gcp", "azure", "kubernetes", "docker", "snowflake"], icon: Layers },
  { id: "ui", label: "UI & Wireframes", keywords: ["ui", "wireframe", "mobile", "android", "ios", "gadget", "component", "design"], icon: Compass },
  { id: "icons", label: "Icons & Logos", keywords: ["icon", "logo", "brand", "dev", "tech"], icon: Sparkles },
  { id: "diagrams", label: "Flowcharts & Diagrams", keywords: ["flowchart", "diagram", "process", "map", "mindmap", "tree", "chart"], icon: Library },
];

export function ExcalidrawLibraryModal({ isOpen, onClose, excalidrawAPI }: ExcalidrawLibraryModalProps) {
  const [libraries, setLibraries] = useState<ExcalidrawLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [loadingLibId, setLoadingLibId] = useState<string | null>(null);
  const [addedLibIds, setAddedLibIds] = useState<Set<string>>(new Set());

  const addToast = useAppStore((s) => s.addToast);
  const excalidrawAddedLibraryIds = useAppStore((s) => s.excalidrawAddedLibraryIds || []);
  const addExcalidrawAddedLibraryId = useAppStore((s) => s.addExcalidrawAddedLibraryId);

  useEffect(() => {
    if (isOpen) {
      if (excalidrawAPI) {
        try {
          excalidrawAPI.updateScene({
            appState: {
              openSidebar: { name: "library", tab: "libraries" },
            } as any,
          });
        } catch {
          // Fallback
        }
      }
      setLoading(true);
      getExcalidrawLibraries().then((data) => {
        setLibraries(data);
        setLoading(false);
      });
    }
  }, [isOpen, excalidrawAPI]);

  const handleCloseModal = () => {
    // Ensure Excalidraw library sidebar remains open when closing the community libraries modal
    if (excalidrawAPI) {
      try {
        excalidrawAPI.updateScene({
          appState: {
            openSidebar: { name: "library", tab: "libraries" },
          } as any,
        });
      } catch {
        // Fallback
      }
    }
    onClose();
  };

  // Close modal on Escape key press
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCloseModal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, excalidrawAPI]);

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

    const isAlreadyAdded = excalidrawAddedLibraryIds.includes(lib.id) || addedLibIds.has(lib.id);
    if (isAlreadyAdded) {
      addToast({ message: `"${lib.name}" is already in your library`, type: "info" });
      return;
    }

    try {
      setLoadingLibId(lib.id);
      const count = await loadLibraryToExcalidraw(lib.source, excalidrawAPI);
      setAddedLibIds((prev) => new Set(prev).add(lib.id));
      addExcalidrawAddedLibraryId(lib.id);
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
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleCloseModal();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "1100px",
          height: "85vh",
          backgroundColor: "var(--bg-1)",
          border: "1px solid var(--border-2)",
          borderRadius: "16px",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.6)",
        }}
      >
        {/* ROW 1: Modal Header (Title + Collections Badge + Close) */}
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--border-1)",
            backgroundColor: "var(--bg-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                padding: "8px",
                borderRadius: "8px",
                backgroundColor: "var(--accent-glow)",
                color: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Library style={{ width: 20, height: 20 }} />
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h2 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-1)", margin: 0 }}>
                  Excalidraw Community Libraries
                </h2>
                <span
                  style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    backgroundColor: "var(--accent-glow)",
                    color: "var(--accent)",
                    fontWeight: 500,
                    border: "1px solid var(--border-accent)",
                  }}
                >
                  {libraries.length} Collections
                </span>
              </div>
              <p style={{ fontSize: "12px", color: "var(--text-2)", margin: "2px 0 0 0" }}>
                Discover and import official community shape packs directly into your DrawFlow canvas.
              </p>
            </div>
          </div>

          <button
            onClick={handleCloseModal}
            style={{
              padding: "6px",
              borderRadius: "8px",
              color: "var(--text-2)",
              backgroundColor: "transparent",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Close modal"
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* ROW 2: Search Input & Category Pills */}
        <div
          style={{
            padding: "12px 24px",
            borderBottom: "1px solid var(--border-1)",
            backgroundColor: "var(--bg-1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "16px",
            flexShrink: 0,
            flexWrap: "wrap",
          }}
        >
          {/* Search Box */}
          <div style={{ position: "relative", flex: "1 1 280px", maxWidth: "360px" }}>
            <Search
              style={{
                width: 14,
                height: 14,
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-3)",
              }}
            />
            <input
              type="text"
              placeholder="Search libraries (AWS, GCP, Icons...)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                paddingLeft: "34px",
                paddingRight: "28px",
                paddingTop: "7px",
                paddingBottom: "7px",
                fontSize: "12px",
                backgroundColor: "var(--bg-2)",
                border: "1px solid var(--border-1)",
                borderRadius: "8px",
                color: "var(--text-1)",
                outline: "none",
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-3)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                <X style={{ width: 12, height: 12 }} />
              </button>
            )}
          </div>

          {/* Category Tabs */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", overflowX: "auto", padding: "2px 0" }}>
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isActive = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  style={{
                    fontSize: "12px",
                    padding: "5px 12px",
                    borderRadius: "6px",
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    backgroundColor: isActive ? "var(--accent)" : "var(--bg-2)",
                    color: isActive ? "#ffffff" : "var(--text-2)",
                    border: isActive ? "none" : "1px solid var(--border-1)",
                  }}
                >
                  <Icon style={{ width: 12, height: 12 }} />
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ROW 3: Scrollable Card Grid */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 24px",
            backgroundColor: "var(--bg-0)",
          }}
        >
          {loading ? (
            /* Skeleton Loading Grid */
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "16px" }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    backgroundColor: "var(--bg-1)",
                    border: "1px solid var(--border-1)",
                    borderRadius: "12px",
                    padding: "12px",
                    height: "220px",
                    opacity: 0.6,
                  }}
                />
              ))}
            </div>
          ) : filteredLibraries.length === 0 ? (
            /* Empty State */
            <div
              style={{
                height: "100%",
                minHeight: "260px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-3)",
                gap: "12px",
              }}
            >
              <LayoutGrid style={{ width: 32, height: 32 }} />
              <p style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-2)", margin: 0 }}>
                No matching libraries found
              </p>
              <p style={{ fontSize: "11px", color: "var(--text-3)", margin: 0 }}>
                Try clearing your search or selecting a different category.
              </p>
              {(searchQuery || activeCategory !== "all") && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setActiveCategory("all");
                  }}
                  style={{
                    marginTop: "8px",
                    fontSize: "12px",
                    padding: "6px 12px",
                    borderRadius: "6px",
                    backgroundColor: "var(--bg-2)",
                    border: "1px solid var(--border-1)",
                    color: "var(--text-2)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <RotateCcw style={{ width: 12, height: 12 }} />
                  <span>Reset Filters</span>
                </button>
              )}
            </div>
          ) : (
            /* Cards Grid */
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                gap: "16px",
              }}
            >
              {filteredLibraries.map((lib) => {
                const isAdded = excalidrawAddedLibraryIds.includes(lib.id) || addedLibIds.has(lib.id);
                const isLoadingThis = loadingLibId === lib.id;
                const previewUrl = getExcalidrawLibraryPreviewUrl(lib.preview);
                const cdnPreviewUrl = getExcalidrawLibraryCdnPreviewUrl(lib.preview);

                return (
                  <div
                    key={lib.id}
                    style={{
                      backgroundColor: "var(--bg-1)",
                      border: "1px solid var(--border-1)",
                      borderRadius: "12px",
                      padding: "14px",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div>
                      {/* Image Preview Box */}
                      <div
                        style={{
                          width: "100%",
                          height: "125px",
                          backgroundColor: "#ffffff",
                          borderRadius: "8px",
                          border: "1px solid var(--border-1)",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "8px",
                          marginBottom: "12px",
                          flexShrink: 0,
                        }}
                      >
                        <img
                          src={previewUrl}
                          alt={lib.name}
                          style={{
                            maxWidth: "100%",
                            maxHeight: "100%",
                            objectFit: "contain",
                            display: "block",
                            margin: "0 auto",
                          }}
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

                      {/* Title & Description */}
                      <h3
                        style={{
                          fontSize: "13px",
                          fontWeight: 600,
                          color: "var(--text-1)",
                          margin: "0 0 4px 0",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lib.name}
                      </h3>
                      <p
                        style={{
                          fontSize: "11px",
                          color: "var(--text-2)",
                          margin: "0 0 10px 0",
                          lineHeight: "1.4",
                          height: "30px",
                          overflow: "hidden",
                        }}
                      >
                        {lib.description}
                      </p>

                      {/* Author Link */}
                      {lib.authors.length > 0 && (
                        <div
                          style={{
                            fontSize: "10px",
                            color: "var(--text-3)",
                            marginBottom: "12px",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          <span>by</span>
                          <a
                            href={lib.authors[0]!.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: "var(--text-2)",
                              fontWeight: 500,
                              textDecoration: "none",
                              display: "flex",
                              alignItems: "center",
                              gap: "2px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              maxWidth: "140px",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span>{lib.authors[0]!.name}</span>
                            <ArrowUpRight style={{ width: 10, height: 10, opacity: 0.6 }} />
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Action Button */}
                    <button
                      onClick={() => handleAddLibrary(lib)}
                      disabled={isLoadingThis || isAdded}
                      style={{
                        width: "100%",
                        padding: "7px 12px",
                        borderRadius: "8px",
                        fontSize: "12px",
                        fontWeight: 500,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "6px",
                        cursor: isLoadingThis ? "wait" : isAdded ? "not-allowed" : "pointer",
                        border: "none",
                        transition: "all 0.15s ease",
                        backgroundColor: isAdded ? "rgba(16, 185, 129, 0.15)" : "var(--accent)",
                        color: isAdded ? "#34d399" : "#ffffff",
                        opacity: isAdded ? 0.85 : 1,
                      }}
                    >
                      {isLoadingThis ? (
                        <>
                          <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
                          <span>Downloading...</span>
                        </>
                      ) : isAdded ? (
                        <>
                          <Check style={{ width: 14, height: 14 }} />
                          <span>Added to DrawFlow</span>
                        </>
                      ) : (
                        <>
                          <Plus style={{ width: 14, height: 14 }} />
                          <span>Add to DrawFlow</span>
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
