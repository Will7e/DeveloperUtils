// ============================================================
// API Tester — Preset & Platform Library Modal
// ============================================================

import { useState, useMemo, useEffect } from "react";
import {
  X,
  Search,
  BookOpen,
  FolderPlus,
  Sliders,
  ExternalLink,
  Copy,
  Check,
  Plus,
  Globe,
  Layers,
  Library,
  Bot,
  Terminal,
  Code2,
  Trash2,
  Bookmark,
  Shield,
  Key,
} from "lucide-react";
import {
  LIBRARY_PRESETS,
  PLATFORMS,
  type LibraryPreset,
  type PlatformId,
  type PlatformMetadata,
} from "../data/preset-library.data";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { SimpleTooltip } from "@/components/ui/tooltip";

interface ApiLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ApiLibraryModal({ isOpen, onClose }: ApiLibraryModalProps) {
  const store = useApiTesterStore();
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [methodFilter, setMethodFilter] = useState<string>("ALL");
  const [inspectingPreset, setInspectingPreset] = useState<LibraryPreset | null>(null);
  const [copiedCurlId, setCopiedCurlId] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (inspectingPreset) {
          setInspectingPreset(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, inspectingPreset, onClose]);

  // Combined presets: built-in library + custom saved presets
  const allPresets = useMemo(() => {
    return [...LIBRARY_PRESETS, ...(store.customPresets || [])];
  }, [store.customPresets]);

  // Filtered presets
  const filteredPresets = useMemo(() => {
    return allPresets.filter((preset) => {
      // Platform filter
      if (selectedPlatform === "custom") {
        if (preset.platform !== "custom") return false;
      } else if (selectedPlatform !== "all" && preset.platform !== selectedPlatform) {
        return false;
      }

      // Method filter
      if (methodFilter !== "ALL" && preset.method !== methodFilter) {
        return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesName = preset.name.toLowerCase().includes(query);
        const matchesUrl = preset.url.toLowerCase().includes(query);
        const matchesDesc = preset.description.toLowerCase().includes(query);
        const matchesCategory = preset.category.toLowerCase().includes(query);
        const matchesTags = preset.tags.some((t) => t.toLowerCase().includes(query));
        const matchesPlatform = preset.platformName.toLowerCase().includes(query);
        if (
          !matchesName &&
          !matchesUrl &&
          !matchesDesc &&
          !matchesCategory &&
          !matchesTags &&
          !matchesPlatform
        ) {
          return false;
        }
      }

      return true;
    });
  }, [allPresets, selectedPlatform, methodFilter, searchQuery]);

  // Counts by platform
  const platformCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allPresets.length, custom: store.customPresets?.length || 0 };
    PLATFORMS.forEach((p) => {
      counts[p.id] = allPresets.filter((item) => item.platform === p.id).length;
    });
    return counts;
  }, [allPresets, store.customPresets]);

  // Active platform metadata
  const currentPlatformMeta: PlatformMetadata | undefined = useMemo(() => {
    return PLATFORMS.find((p) => p.id === selectedPlatform);
  }, [selectedPlatform]);

  const handleCopyCurl = (preset: LibraryPreset, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    let curl = `curl -X ${preset.method} "${preset.url}"`;
    if (preset.headers && preset.headers.length > 0) {
      preset.headers.forEach((h) => {
        curl += ` \\\n  -H "${h.key}: ${h.value}"`;
      });
    }
    if (preset.bodyValue && preset.bodyType !== "none") {
      curl += ` \\\n  -d '${preset.bodyValue.replace(/'/g, "'\\''")}'`;
    }
    navigator.clipboard.writeText(curl);
    setCopiedCurlId(preset.id);
    setTimeout(() => setCopiedCurlId(null), 2000);
  };

  const handleAddToTester = (preset: LibraryPreset) => {
    store.loadLibraryPreset(preset);
    onClose();
  };

  const handleAddToCollections = (preset: LibraryPreset, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    store.importPlatformCollection(preset.platformName, [preset]);
  };

  const handleBulkImportPlatform = (platform: PlatformMetadata) => {
    const presetsForPlatform = allPresets.filter((p) => p.platform === platform.id);
    if (presetsForPlatform.length === 0) return;
    store.importPlatformCollection(platform.name, presetsForPlatform);
  };

  const handleInjectPlatformEnv = (platform: PlatformMetadata) => {
    if (!platform.envVariables || platform.envVariables.length === 0) return;
    store.injectEnvironmentVariables(platform.envVariables, platform.name);
  };

  if (!isOpen) return null;

  return (
    <div className="api-modal-overlay api-library-modal-overlay">
      <div
        className="api-modal-content api-library-modal-content"
        style={{
          maxWidth: "1150px",
          width: "95vw",
          height: "82vh",
          maxHeight: "850px",
          padding: 0,
          flexDirection: "row",
          overflow: "hidden",
        }}
      >
        {/* ── Left Sidebar: Platforms & Filters ───────────────────── */}
        <aside className="api-library-sidebar">
          <div className="api-library-sidebar-header">
            <div className="flex items-center gap-2">
              <Library className="h-4 w-4 text-accent" />
              <span className="font-semibold text-sm text-[var(--text-1)]">Preset Library</span>
            </div>
            <span className="api-library-badge-count">{allPresets.length} items</span>
          </div>

          <div className="api-library-sidebar-nav">
            <div className="api-library-nav-group-label">Platforms</div>

            {/* All Presets */}
            <button
              className={`api-library-platform-btn ${
                selectedPlatform === "all" ? "api-library-platform-btn-active" : ""
              }`}
              onClick={() => setSelectedPlatform("all")}
            >
              <div className="flex items-center gap-2.5">
                <Globe className="h-4 w-4" style={{ color: "var(--accent)" }} />
                <span>All Platforms</span>
              </div>
              <span className="api-library-count-pill">{platformCounts.all || 0}</span>
            </button>

            {/* Platform list */}
            {PLATFORMS.map((platform) => {
              const count = platformCounts[platform.id] || 0;
              const isActive = selectedPlatform === platform.id;
              return (
                <button
                  key={platform.id}
                  className={`api-library-platform-btn ${
                    isActive ? "api-library-platform-btn-active" : ""
                  }`}
                  onClick={() => setSelectedPlatform(platform.id)}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="api-library-platform-dot"
                      style={{ backgroundColor: platform.brandColor }}
                    />
                    <span>{platform.shortName}</span>
                  </div>
                  <span className="api-library-count-pill">{count}</span>
                </button>
              );
            })}

            <div className="api-library-nav-group-label" style={{ marginTop: "16px" }}>
              Personal
            </div>
            <button
              className={`api-library-platform-btn ${
                selectedPlatform === "custom" ? "api-library-platform-btn-active" : ""
              }`}
              onClick={() => setSelectedPlatform("custom")}
            >
              <div className="flex items-center gap-2.5">
                <Bookmark className="h-4 w-4 text-yellow" />
                <span>My Presets</span>
              </div>
              <span className="api-library-count-pill">{platformCounts.custom || 0}</span>
            </button>
          </div>

          {/* Quick Stats or Tips Footer */}
          <div className="api-library-sidebar-footer">
            <div className="flex items-center gap-2 text-xs text-[var(--text-3)]">
              <Key className="h-3.5 w-3.5 text-accent" />
              <span>Use &#123;&#123;var&#125;&#125; for env variables</span>
            </div>
          </div>
        </aside>

        {/* ── Main Content Area: Cards & Search ──────────────────── */}
        <main className="api-library-main">
          {/* Top Bar: Search, Method Filter & Close */}
          <div className="api-library-topbar">
            <div className="api-library-search-box">
              <Search className="h-4 w-4 text-[var(--text-3)]" />
              <input
                type="text"
                placeholder="Search presets by name, endpoint URL, method, tags..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              {searchQuery && (
                <button
                  className="api-library-clear-search"
                  onClick={() => setSearchQuery("")}
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Method Filter Chips */}
            <div className="api-library-method-chips">
              {["ALL", "GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => (
                <button
                  key={m}
                  className={`api-library-method-chip ${
                    methodFilter === m ? "api-library-method-chip-active" : ""
                  }`}
                  onClick={() => setMethodFilter(m)}
                >
                  {m}
                </button>
              ))}
            </div>

            <button
              className="api-modal-close"
              onClick={onClose}
              title="Close Library (Esc)"
              style={{ marginLeft: "8px" }}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Platform Banner (when a specific platform is selected) */}
          {currentPlatformMeta && (
            <div
              className="api-library-platform-banner"
              style={{ borderLeftColor: currentPlatformMeta.brandColor }}
            >
              <div className="api-library-banner-info">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold text-sm text-[var(--text-1)]">
                    {currentPlatformMeta.name}
                  </h4>
                  {currentPlatformMeta.docsUrl && (
                    <a
                      href={currentPlatformMeta.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="api-library-docs-link"
                      title="View Official API Documentation"
                    >
                      <BookOpen className="h-3 w-3" />
                      <span>Docs</span>
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
                <p className="text-xs text-[var(--text-2)]">{currentPlatformMeta.description}</p>
              </div>

              <div className="api-library-banner-actions">
                {currentPlatformMeta.envVariables.length > 0 && (
                  <button
                    className="api-library-banner-btn"
                    onClick={() => handleInjectPlatformEnv(currentPlatformMeta)}
                    title="Populate required template variables into your active environment"
                  >
                    <Sliders className="h-3.5 w-3.5 text-accent" />
                    <span>Configure Variables ({currentPlatformMeta.envVariables.length})</span>
                  </button>
                )}

                <button
                  className="api-library-banner-btn"
                  onClick={() => handleBulkImportPlatform(currentPlatformMeta)}
                  title="Import all requests for this platform into a new collection"
                >
                  <FolderPlus className="h-3.5 w-3.5 text-green" />
                  <span>Import All to Collections</span>
                </button>
              </div>
            </div>
          )}

          {/* Preset Cards List */}
          <div className="api-library-cards-container">
            {filteredPresets.length === 0 ? (
              <div className="api-library-empty-state">
                <Layers className="h-8 w-8 text-[var(--text-3)] opacity-40 mb-2" />
                <h4 className="font-medium text-sm text-[var(--text-2)]">No Presets Found</h4>
                <p className="text-xs text-[var(--text-3)] max-w-sm text-center mt-1">
                  {searchQuery
                    ? `No presets match "${searchQuery}". Try clearing search or switching categories.`
                    : selectedPlatform === "custom"
                    ? "You haven't saved any custom presets yet. You can save any active request tab into your library!"
                    : "No presets in this category."}
                </p>
                {searchQuery && (
                  <button
                    className="api-btn-secondary text-xs mt-3 px-3 py-1.5"
                    onClick={() => {
                      setSearchQuery("");
                      setMethodFilter("ALL");
                    }}
                  >
                    Reset Filters
                  </button>
                )}
              </div>
            ) : (
              <div className="api-library-cards-grid">
                {filteredPresets.map((preset) => {
                  const isCopied = copiedCurlId === preset.id;
                  return (
                    <div
                      key={preset.id}
                      className="api-library-card"
                      onClick={() => setInspectingPreset(preset)}
                    >
                      {/* Top Header: Method badge, Platform Tag & Actions */}
                      <div className="api-library-card-header">
                        <div className="flex items-center gap-2">
                          <span
                            className={`api-badge api-badge-${preset.method.toLowerCase()}`}
                            style={{ fontSize: "9px", padding: "2px 5px", width: "auto" }}
                          >
                            {preset.method}
                          </span>
                          <span className="api-library-card-platform">
                            {preset.platformName}
                          </span>
                        </div>

                        <div className="api-library-card-actions" onClick={(e) => e.stopPropagation()}>
                          <SimpleTooltip content="Copy cURL Command">
                            <button
                              className="api-library-card-icon-btn"
                              onClick={(e) => handleCopyCurl(preset, e)}
                            >
                              {isCopied ? (
                                <Check className="h-3.5 w-3.5 text-green" />
                              ) : (
                                <Terminal className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </SimpleTooltip>

                          <SimpleTooltip content="Add to Collections">
                            <button
                              className="api-library-card-icon-btn"
                              onClick={(e) => handleAddToCollections(preset, e)}
                            >
                              <FolderPlus className="h-3.5 w-3.5" />
                            </button>
                          </SimpleTooltip>

                          {preset.platform === "custom" && (
                            <SimpleTooltip content="Delete Custom Preset">
                              <button
                                className="api-library-card-icon-btn text-red hover:bg-red-500/10"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  store.deleteCustomPreset(preset.id);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </SimpleTooltip>
                          )}
                        </div>
                      </div>

                      {/* Card Title & Description */}
                      <div className="api-library-card-body">
                        <h4 className="api-library-card-title">{preset.name}</h4>
                        <p className="api-library-card-desc">{preset.description}</p>
                      </div>

                      {/* Endpoint URL Pill */}
                      <div className="api-library-card-url" title={preset.url}>
                        <code>{preset.url}</code>
                      </div>

                      {/* Card Footer: Category tag & Add to Tester Button */}
                      <div className="api-library-card-footer">
                        <span className="api-library-card-category">{preset.category}</span>

                        <button
                          className="api-library-add-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddToTester(preset);
                          }}
                        >
                          <Plus className="h-3 w-3" />
                          <span>Add to Test</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {/* ── Detail Inspection Slide-Over / Modal ─────────────────── */}
        {inspectingPreset && (
          <div className="api-library-inspector-backdrop" onClick={() => setInspectingPreset(null)}>
            <div
              className="api-library-inspector"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="api-library-inspector-header">
                <div>
                  <span
                    className={`api-badge api-badge-${inspectingPreset.method.toLowerCase()}`}
                    style={{ fontSize: "10px", padding: "2px 6px", width: "auto" }}
                  >
                    {inspectingPreset.method}
                  </span>
                  <h3 className="text-base font-semibold text-[var(--text-1)] mt-1.5">
                    {inspectingPreset.name}
                  </h3>
                  <span className="text-xs text-[var(--text-3)]">
                    {inspectingPreset.platformName} • {inspectingPreset.category}
                  </span>
                </div>

                <button
                  className="api-modal-close"
                  onClick={() => setInspectingPreset(null)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="api-library-inspector-body">
                {/* Description */}
                <div className="api-inspector-section">
                  <div className="api-inspector-label">Description</div>
                  <p className="text-xs text-[var(--text-2)] leading-relaxed">
                    {inspectingPreset.description}
                  </p>
                  {inspectingPreset.docsUrl && (
                    <a
                      href={inspectingPreset.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline mt-1.5"
                    >
                      <BookOpen className="h-3 w-3" />
                      <span>Official Documentation</span>
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>

                {/* Endpoint URL */}
                <div className="api-inspector-section">
                  <div className="api-inspector-label">Request Endpoint</div>
                  <div className="api-inspector-code-box">
                    <code>{inspectingPreset.url}</code>
                  </div>
                </div>

                {/* Authentication Type */}
                <div className="api-inspector-section">
                  <div className="api-inspector-label">Authentication</div>
                  <div className="flex items-center gap-2 text-xs text-[var(--text-2)]">
                    <Shield className="h-3.5 w-3.5 text-accent" />
                    <span className="capitalize font-medium text-[var(--text-1)]">
                      {inspectingPreset.authType === "none" || !inspectingPreset.authType
                        ? "None Required / In Headers"
                        : inspectingPreset.authType}
                    </span>
                  </div>
                </div>

                {/* Query Parameters */}
                {inspectingPreset.params && inspectingPreset.params.length > 0 && (
                  <div className="api-inspector-section">
                    <div className="api-inspector-label">
                      Query Parameters ({inspectingPreset.params.length})
                    </div>
                    <div className="api-inspector-table">
                      <div className="api-inspector-table-header">
                        <span>Key</span>
                        <span>Value</span>
                      </div>
                      {inspectingPreset.params.map((param, idx) => (
                        <div key={idx} className="api-inspector-table-row">
                          <span className="font-mono text-accent">{param.key}</span>
                          <span className="font-mono text-[var(--text-2)]">{param.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Headers */}
                {inspectingPreset.headers && inspectingPreset.headers.length > 0 && (
                  <div className="api-inspector-section">
                    <div className="api-inspector-label">
                      Headers ({inspectingPreset.headers.length})
                    </div>
                    <div className="api-inspector-table">
                      <div className="api-inspector-table-header">
                        <span>Header</span>
                        <span>Value</span>
                      </div>
                      {inspectingPreset.headers.map((header, idx) => (
                        <div key={idx} className="api-inspector-table-row">
                          <span className="font-mono text-accent">{header.key}</span>
                          <span className="font-mono text-[var(--text-2)]">{header.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Request Body */}
                {inspectingPreset.bodyValue && inspectingPreset.bodyType !== "none" && (
                  <div className="api-inspector-section">
                    <div className="api-inspector-label">
                      Request Body ({inspectingPreset.bodyType})
                    </div>
                    <pre className="api-inspector-code-box font-mono text-xs overflow-x-auto p-3">
                      {inspectingPreset.bodyValue}
                    </pre>
                  </div>
                )}

                {/* Template Environment Variables */}
                {inspectingPreset.envVariables && inspectingPreset.envVariables.length > 0 && (
                  <div className="api-inspector-section">
                    <div className="api-inspector-label">Required Variables</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {inspectingPreset.envVariables.map((env) => (
                        <span key={env.key} className="api-library-tag" title={env.description}>
                          &#123;&#123;{env.key}&#125;&#125;
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Inspector Footer Actions */}
              <div className="api-library-inspector-footer">
                <button
                  className="api-btn-secondary flex items-center gap-1.5 text-xs py-2 px-3"
                  onClick={() => handleCopyCurl(inspectingPreset)}
                >
                  {copiedCurlId === inspectingPreset.id ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-green" />
                      <span>Copied cURL!</span>
                    </>
                  ) : (
                    <>
                      <Terminal className="h-3.5 w-3.5" />
                      <span>Copy cURL</span>
                    </>
                  )}
                </button>

                <button
                  className="api-send-btn flex items-center gap-1.5 text-xs py-2 px-4"
                  onClick={() => handleAddToTester(inspectingPreset)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add to API Tester</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
