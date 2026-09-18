import React, { useRef, useState, useMemo, useEffect } from "react";
import {
  Globe,
  Library,
  History,
  Folder,
  FileJson,
  FolderUp,
  ChevronRight,
  X,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  BookmarkPlus,
} from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useApiTesterStore, type ImportedRequest } from "@/stores/api-tester.store";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import { formatRelativeTime } from "../constants";
import {
  LIBRARY_PRESETS,
  PLATFORMS,
  type LibraryPreset,
  type PlatformId,
} from "../data/preset-library.data";

interface ApiSidebarProps {
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
}

export function ApiSidebar({ onOpenSettings, onOpenLibrary }: ApiSidebarProps) {
  const store = useApiTesterStore();

  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorageState(
    "devutils_api_sidebar_collapsed",
    false
  );
  const [presetsOpen, setPresetsOpen] = useLocalStorageState(
    "devutils_api_sidebar_presets",
    false
  );
  const [historyOpen, setHistoryOpen] = useLocalStorageState(
    "devutils_api_sidebar_history",
    false
  );
  const [collectionsOpen, setCollectionsOpen] = useLocalStorageState(
    "devutils_api_sidebar_collections",
    false
  );

  const [sidebarPlatform, setSidebarPlatform] = useState<PlatformId>("all");

  // Added built-in presets from LIBRARY_PRESETS
  const addedBuiltInPresets = useMemo(() => {
    const ids = new Set(store.addedPresetIds || []);
    return LIBRARY_PRESETS.filter((p) => ids.has(p.id));
  }, [store.addedPresetIds]);

  // Combined presets: custom presets + added built-in presets
  const allSidebarPresets = useMemo(() => {
    return [...(store.customPresets || []), ...addedBuiltInPresets];
  }, [store.customPresets, addedBuiltInPresets]);

  // Derive which platform filter pills to display based on added presets
  const activePlatforms = useMemo(() => {
    if (allSidebarPresets.length === 0) return [];

    const platformIdsInUse = new Set(allSidebarPresets.map((p) => p.platform));
    const pills: Array<{ id: PlatformId; label: string }> = [
      { id: "all", label: "All" },
    ];

    if (platformIdsInUse.has("custom")) {
      pills.push({ id: "custom", label: "My Presets" });
    }

    PLATFORMS.forEach((plat) => {
      if (platformIdsInUse.has(plat.id)) {
        pills.push({ id: plat.id, label: plat.shortName });
      }
    });

    return pills;
  }, [allSidebarPresets]);

  // Reset sidebarPlatform to "all" if current platform is no longer present
  useEffect(() => {
    if (
      sidebarPlatform !== "all" &&
      !activePlatforms.some((p) => p.id === sidebarPlatform)
    ) {
      setSidebarPlatform("all");
    }
  }, [activePlatforms, sidebarPlatform]);

  const displayedPresets = useMemo(() => {
    if (sidebarPlatform === "all") return allSidebarPresets;
    return allSidebarPresets.filter((p) => p.platform === sidebarPlatform);
  }, [allSidebarPresets, sidebarPlatform]);

  const handleSaveActiveTabToLibrary = () => {
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!activeTab) return;
    const newCustomPreset: LibraryPreset = {
      id: `custom-${Date.now()}`,
      name: activeTab.name || "Custom Request",
      platform: "custom",
      platformName: "My Presets",
      category: "Custom",
      method: activeTab.method,
      url: activeTab.url,
      description: `Saved from active tab on ${new Date().toLocaleDateString()}`,
      params: activeTab.params.filter((p) => p.key.trim() !== "").map((p) => ({ key: p.key, value: p.value })),
      headers: activeTab.headers.filter((h) => h.key.trim() !== "").map((h) => ({ key: h.key, value: h.value })),
      bodyType: activeTab.bodyType,
      bodyValue: activeTab.bodyValue,
      rawType: activeTab.rawType,
      authType: activeTab.authType,
      authConfig: activeTab.authConfig,
      tags: ["custom", activeTab.method.toLowerCase()],
    };
    store.saveCustomPreset(newCustomPreset);
  };

  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportFiles = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const requests: ImportedRequest[] = [];
    let folderName = "Imported Files";
    let skippedCount = 0;

    if (files[0] && files[0].webkitRelativePath) {
      const parts = files[0].webkitRelativePath.split("/");
      if (parts.length > 1 && parts[0]) {
        folderName = parts[0];
      }
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      if (!file.name.endsWith(".json")) {
        skippedCount++;
        continue;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (parsed && parsed.method && parsed.url) {
          requests.push(parsed);
        } else {
          skippedCount++;
        }
      } catch {
        console.error("Failed to parse", file.name);
        skippedCount++;
      }
    }

    const { addToast } = await import("@/stores/app.store").then((m) => m.useAppStore.getState());

    if (requests.length > 0) {
      store.importCollection(folderName, requests);
      if (skippedCount > 0) {
        addToast({
          message: `Imported ${requests.length} requests. Skipped ${skippedCount} invalid files.`,
          type: "info",
          duration: 4000,
        });
      } else {
        addToast({
          message: `Successfully imported ${requests.length} requests.`,
          type: "success",
          duration: 2500,
        });
      }
    } else if (skippedCount > 0) {
      addToast({
        message: `Failed to import. Skipped ${skippedCount} files due to invalid JSON or missing fields.`,
        type: "error",
        duration: 4000,
      });
    }

    if (e.target) e.target.value = "";
  };

  return (
    <aside
      className={`api-sidebar ${
        sidebarCollapsed ? "api-sidebar-collapsed" : ""
      }`}
    >
      <div
        className="api-sidebar-header"
        style={{
          justifyContent: "space-between",
          paddingRight: sidebarCollapsed ? "0" : "8px",
          paddingLeft: sidebarCollapsed ? "0" : "16px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            justifyContent: sidebarCollapsed ? "center" : "flex-start",
            width: sidebarCollapsed ? "100%" : "auto",
          }}
        >
          {sidebarCollapsed ? (
            <button
              className="api-sidebar-footer-icon-btn"
              onClick={() => setSidebarCollapsed(false)}
              title="Expand Sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          ) : (
            <>
              <Globe className="h-4 w-4 text-accent" />
              <span>API Client</span>
            </>
          )}
        </div>
        {!sidebarCollapsed && (
          <button
            className="api-sidebar-footer-icon-btn"
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        style={{ display: "none" }}
        multiple
        accept=".json"
        onChange={handleImportFiles}
      />
      <input
        type="file"
        ref={folderInputRef}
        style={{ display: "none" }}
        {...(
          { webkitdirectory: "", directory: "" } as unknown as Record<
            string,
            string
          >
        )}
        onChange={handleImportFiles}
      />

      <div className="api-sidebar-content">
        {/* Presets & API Library Section */}
        <SidebarSection
          icon={<Library className="h-4 w-4 text-accent" />}
          title="API Library"
          isOpen={presetsOpen}
          onToggle={() => {
            if (sidebarCollapsed) {
              onOpenLibrary();
            } else {
              setPresetsOpen(!presetsOpen);
            }
          }}
          collapsed={sidebarCollapsed}
          actions={
            !sidebarCollapsed ? (
              <div style={{ display: "flex", gap: "4px" }}>
                <SimpleTooltip content="Save Active Tab as Custom Preset">
                  <button
                    className="api-sidebar-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSaveActiveTabToLibrary();
                    }}
                    style={{ padding: "2px 4px" }}
                    title="Save active tab to presets"
                  >
                    <BookmarkPlus className="h-3 w-3 text-yellow" />
                  </button>
                </SimpleTooltip>
              </div>
            ) : undefined
          }
        >
          <div className="api-sidebar-section-body-inner">
            {/* Primary Browse Button */}
            <button
              className="api-sidebar-browse-library-btn"
              onClick={onOpenLibrary}
            >
              <div className="flex items-center gap-2">
                <Library className="h-4 w-4 text-accent" />
                <span className="font-semibold">Browse Library</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="api-sidebar-library-count">
                  {allSidebarPresets.length > 0
                    ? `${allSidebarPresets.length} added`
                    : `${LIBRARY_PRESETS.length} available`}
                </span>
                <ChevronRight className="h-3 w-3 opacity-60" />
              </div>
            </button>

            {/* Quick Platform Filter Pills — only displayed for platforms that have added presets! */}
            {activePlatforms.length > 1 && (
              <div className="api-sidebar-quick-pills">
                {activePlatforms.map((qp) => (
                  <button
                    key={qp.id}
                    className={`api-sidebar-quick-pill ${
                      sidebarPlatform === qp.id ? "api-sidebar-quick-pill-active" : ""
                    }`}
                    onClick={() => setSidebarPlatform(qp.id)}
                  >
                    {qp.label}
                  </button>
                ))}
              </div>
            )}

            {/* Preset Cards or Empty State */}
            {allSidebarPresets.length === 0 ? (
              <div className="api-sidebar-empty-presets">
                <span className="api-sidebar-empty-presets-title">No Presets Added</span>
                <p className="api-sidebar-empty-presets-desc">
                  Click Browse Library above to add presets to your sidebar.
                </p>
              </div>
            ) : (
              <div className="api-sidebar-presets-list">
                {displayedPresets.map((preset) => (
                  <div key={preset.id} className="api-preset-card-wrapper">
                    <button
                      className="api-preset-card"
                      onClick={() => store.loadLibraryPreset(preset)}
                      title={`${preset.name}\n${preset.description}`}
                    >
                      <span
                        className={`api-badge api-badge-${preset.method.toLowerCase()}`}
                      >
                        {preset.method}
                      </span>
                      <div className="api-item-info">
                        <span className="api-item-url">{preset.name}</span>
                        <span className="api-item-meta">{preset.url}</span>
                      </div>
                    </button>
                    <SimpleTooltip content="Remove preset from sidebar">
                      <button
                        className="api-preset-remove-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (preset.platform === "custom") {
                            store.deleteCustomPreset(preset.id);
                          } else {
                            store.removePresetFromSidebar(preset.id);
                          }
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </SimpleTooltip>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SidebarSection>

        {/* Collections Section */}
        <SidebarSection
          icon={<Folder className="h-4 w-4" />}
          title="Collections"
          isOpen={collectionsOpen}
          onToggle={() => {
            if (sidebarCollapsed) {
              setSidebarCollapsed(false);
              setCollectionsOpen(true);
            } else {
              setCollectionsOpen(!collectionsOpen);
            }
          }}
          collapsed={sidebarCollapsed}
          actions={
            !sidebarCollapsed ? (
              <div style={{ display: "flex", gap: "4px" }}>
                <SimpleTooltip content="Import JSON File(s)">
                  <button
                    className="api-sidebar-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    style={{ padding: "2px 4px" }}
                  >
                    <FileJson className="h-3 w-3" />
                  </button>
                </SimpleTooltip>
                <SimpleTooltip content="Import Folder">
                  <button
                    className="api-sidebar-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      folderInputRef.current?.click();
                    }}
                    style={{ padding: "2px 4px" }}
                  >
                    <FolderUp className="h-3 w-3" />
                  </button>
                </SimpleTooltip>
              </div>
            ) : undefined
          }
        >
          <div
            className="api-sidebar-section-body-inner"
            style={{ maxHeight: "300px", overflowY: "auto" }}
          >
            {store.collections && store.collections.length === 0 ? (
              <div
                className="api-history-empty"
                style={{ margin: "0 8px" }}
              >
                <Folder className="h-5 w-5 opacity-30" />
                <span className="api-history-empty-title">
                  No Collections
                </span>
                <p className="api-history-empty-desc">
                  Import exported requests or folders here.
                </p>
              </div>
            ) : (
              store.collections?.map((col) => (
                <div
                  key={col.id}
                  className="api-collection-group"
                  style={{ padding: "0 8px" }}
                >
                  <div className="api-collection-header">
                    <Folder className="h-3 w-3 text-accent" />
                    <span className="api-collection-name" title={col.name}>
                      {col.name}
                    </span>
                    <button
                      className="api-collection-remove"
                      onClick={() => store.removeCollection(col.id)}
                      title="Remove Collection"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  {col.requests.map((req, idx) => (
                    <button
                      key={idx}
                      className="api-history-card"
                      onClick={() => store.loadImportedRequest(req)}
                      title={req.name || req.url}
                    >
                      <span
                        className={`api-badge api-badge-${req.method.toLowerCase()}`}
                      >
                        {req.method}
                      </span>
                      <div className="api-item-info">
                        <span className="api-item-url">
                          {req.name || req.url}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </SidebarSection>

        {/* History Section */}
        <SidebarSection
          icon={<History className="h-4 w-4" />}
          title="Request History"
          isOpen={historyOpen}
          onToggle={() => {
            if (sidebarCollapsed) {
              setSidebarCollapsed(false);
              setHistoryOpen(true);
            } else {
              setHistoryOpen(!historyOpen);
            }
          }}
          collapsed={sidebarCollapsed}
          style={{ flex: 1 }}
          bodyStyle={{ flex: 1 }}
          actions={
            !sidebarCollapsed && store.history.length > 0 ? (
              <button
                className="api-clear-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  store.clearHistory();
                }}
              >
                Clear
              </button>
            ) : undefined
          }
        >
          <div
            className="api-sidebar-section-body-inner"
            style={{ maxHeight: "400px", overflowY: "auto" }}
          >
            {store.history.length === 0 ? (
              <div className="api-history-empty">
                <History className="h-5 w-5 opacity-30" />
                <span className="api-history-empty-title">
                  No History Yet
                </span>
                <p className="api-history-empty-desc">
                  Sent requests will appear here for quick replay.
                </p>
              </div>
            ) : (
              store.history.map((item) => (
                <button
                  key={item.id}
                  className="api-history-card"
                  onClick={() => store.loadHistoryItem(item)}
                >
                  <span
                    className={`api-badge api-badge-${item.method.toLowerCase()}`}
                  >
                    {item.method}
                  </span>
                  <div className="api-item-info">
                    <span className="api-item-url">{item.url}</span>
                    <span className="api-item-meta">
                      {item.error ? (
                        <span className="api-item-status-err">Error</span>
                      ) : (
                        <span className="api-item-status-ok">
                          {item.status}
                        </span>
                      )}
                      {item.time && (
                        <span className="api-item-time-label">
                          {item.time}ms
                        </span>
                      )}
                      <span className="api-item-time-label">
                        {formatRelativeTime(item.timestamp)}
                      </span>
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </SidebarSection>
      </div>

      {/* Sidebar Footer */}
      <div
        className="api-sidebar-footer"
        style={{
          justifyContent: sidebarCollapsed ? "center" : "flex-start",
          padding: sidebarCollapsed ? "12px 0" : "12px 16px",
        }}
      >
        <button
          className={
            sidebarCollapsed
              ? "api-sidebar-footer-icon-btn"
              : "api-sidebar-footer-btn"
          }
          title="API Tester Settings"
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
          {!sidebarCollapsed && <span>Settings</span>}
        </button>
      </div>
    </aside>
  );
}

// ── Reusable Sidebar Section ─────────────────────────────────
function SidebarSection({
  icon,
  title,
  isOpen,
  onToggle,
  collapsed,
  actions,
  style,
  bodyStyle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  collapsed: boolean;
  actions?: React.ReactNode;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div className="api-sidebar-section" style={style}>
      <div
        className="api-sidebar-section-header"
        onClick={onToggle}
        title={collapsed ? title : ""}
        style={{
          justifyContent: collapsed ? "center" : "space-between",
          padding: collapsed ? "12px 0" : "8px 8px",
        }}
      >
        <div
          className="api-sidebar-section-left"
          style={{
            justifyContent: collapsed ? "center" : "flex-start",
            width: collapsed ? "100%" : "auto",
          }}
        >
          {!collapsed && (
            <ChevronRight
              className={`h-3 w-3 api-sidebar-section-chevron ${
                isOpen ? "api-sidebar-section-chevron-open" : ""
              }`}
            />
          )}
          {icon}
          {!collapsed && (
            <span className="api-sidebar-section-title">{title}</span>
          )}
        </div>
        {actions}
      </div>
      <div
        className={`api-sidebar-section-body ${
          isOpen && !collapsed ? "api-sidebar-section-body-open" : ""
        }`}
        style={bodyStyle}
      >
        {children}
      </div>
    </div>
  );
}
