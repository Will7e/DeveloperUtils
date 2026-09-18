// ============================================================
// API Tester Component — Premium REST, GraphQL & WebSocket Client
// ============================================================

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { type OnMount } from "@monaco-editor/react";
import { Globe, ChevronDown, Download, Check, Library } from "lucide-react";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { registerMonacoFormatShortcut } from "@/utils/monaco-format";
import { LoadingState } from "@/components/ui/loading-state";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { WorkspaceTabBar, type TabItem } from "@/components/ui/WorkspaceTabBar";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { useAppStore } from "@/stores/app.store";
import "./api-tester.css";

import { ApiSidebar } from "./components/ApiSidebar";
import { UrlBar } from "./components/UrlBar";
import { RequestPane } from "./components/RequestPane";
import { ResponsePane } from "./components/ResponsePane";
import { CurlImportDrawer } from "./components/CurlImportDrawer";
import { CodeSnippetDrawer } from "./components/CodeSnippetDrawer";
import { SettingsModal } from "./components/SettingsModal";
import { ExportModal } from "./components/ExportModal";
import { ApiLibraryModal } from "./components/ApiLibraryModal";
import { useResizablePane } from "./hooks/useResizablePane";

export function ApiTester() {
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);
  const store = useApiTesterStore();
  const tabs = store.tabs;
  const activeTab = tabs.find((t) => t.id === store.activeTabId) || tabs[0];

  // Initialize store on mount
  useEffect(() => {
    useApiTesterStore.getState().init();
  }, []);

  // Editor setup callbacks
  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    setupMonacoTheme(monaco);
    const theme = useAppStore.getState().editorSettings.theme;
    monaco.editor.setTheme(
      theme === "light" ? "devutils-light" : "devutils-dark"
    );
    registerMonacoFormatShortcut(editor, monaco);
  }, []);

  const formatGraphqlQuery = useCallback((value: string) => {
    if (!value || !value.trim()) return value;
    try {
      const query = value.replace(/\s+/g, " ");
      let indent = 0;
      let formatted = "";
      for (let i = 0; i < query.length; i++) {
        const char = query[i];
        if (char === "{") {
          indent += 2;
          formatted += " {\n" + " ".repeat(indent);
        } else if (char === "}") {
          indent = Math.max(0, indent - 2);
          formatted += "\n" + " ".repeat(indent) + "}\n" + " ".repeat(indent);
        } else if (char === ",") {
          formatted += ",\n" + " ".repeat(indent);
        } else {
          formatted += char;
        }
      }
      return formatted
        .replace(/\n\s*\n/g, "\n")
        .replace(/ +/g, " ")
        .replace(/\{ \n/g, "{\n")
        .trim();
    } catch {
      return value;
    }
  }, []);

  const handleGraphqlEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      setupMonacoTheme(monaco);
      const theme = useAppStore.getState().editorSettings.theme;
      monaco.editor.setTheme(
        theme === "light" ? "devutils-light" : "devutils-dark"
      );
      registerMonacoFormatShortcut(editor, monaco);

      editor.addAction({
        id: "graphql-format",
        label: "Format GraphQL Query",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: (ed) => {
          const value = ed.getValue();
          const formatted = formatGraphqlQuery(value);
          if (formatted !== value) {
            ed.setValue(formatted);
            store.setGraphqlQuery(formatted);
            useAppStore.getState().addToast({
              message: "GraphQL query formatted",
              type: "success",
              duration: 1500,
            });
          }
        },
      });

      editor.onDidBlurEditorText(() => {
        const value = editor.getValue();
        if (!value || !value.trim()) return;
        const formatted = formatGraphqlQuery(value);
        if (formatted !== value) {
          editor.setValue(formatted);
          store.setGraphqlQuery(formatted);
        }
      });
    },
    [store, formatGraphqlQuery]
  );

  // Listen for global format event when /api-tester is active
  useEffect(() => {
    const handleExternalFormat = () => {
      const currentActive = useApiTesterStore
        .getState()
        .tabs.find((t) => t.id === useApiTesterStore.getState().activeTabId);
      if (currentActive?.bodyType === "json") {
        useApiTesterStore.getState().formatActiveTabJsonBody();
        useAppStore.getState().addToast({
          message: "JSON formatted",
          type: "success",
          duration: 1500,
        });
      }
    };
    window.addEventListener("devutils:format-api-tester", handleExternalFormat);
    return () =>
      window.removeEventListener(
        "devutils:format-api-tester",
        handleExternalFormat
      );
  }, []);

  // Tab & drawer states
  const [requestTab, setRequestTab] = useState<string>("params");
  const [wsMessageText, setWsMessageText] = useState('{\n  "type": "ping"\n}');
  const [showImportCurl, setShowImportCurl] = useState(false);
  const [showCodeSnippet, setShowCodeSnippet] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showEnvVarsModal, setShowEnvVarsModal] = useState(false);
  const [showLibraryModal, setShowLibraryModal] = useState(false);

  // Environment dropdown state
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [envDropdownPos, setEnvDropdownPos] = useState({ top: 0, right: 0 });
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const envBtnRef = useRef<HTMLButtonElement>(null);

  // Resizable pane
  const {
    paneHeight: requestPaneHeight,
    splitRef,
    isDraggingActive,
    handleResizeStart,
  } = useResizablePane({ initialHeight: 280 });

  // Relative time ticker
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  // Keyboard shortcut: Cmd+Enter (Send), Cmd+Shift+L (Presets Library)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        setShowLibraryModal((prev) => !prev);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        const active = useApiTesterStore
          .getState()
          .tabs.find((t) => t.id === useApiTesterStore.getState().activeTabId);
        if (active && !active.loading && active.url.trim()) {
          if (active.protocol === "websocket") {
            if (active.wsConnected) {
              useApiTesterStore.getState().disconnectWs();
            } else {
              useApiTesterStore.getState().connectWs();
            }
          } else {
            useApiTesterStore.getState().sendRequest();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Close env dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        envDropdownRef.current &&
        !envDropdownRef.current.contains(event.target as Node) &&
        envBtnRef.current &&
        !envBtnRef.current.contains(event.target as Node)
      ) {
        setShowEnvDropdown(false);
      }
    }
    if (showEnvDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showEnvDropdown]);

  const hasBody = activeTab
    ? activeTab.method !== "GET" && activeTab.method !== "HEAD"
    : false;

  // Synchronize requestTab when switching tabs or when body becomes unavailable
  const [prevActiveTabId, setPrevActiveTabId] = useState(activeTab?.id);
  if (activeTab && activeTab.id !== prevActiveTabId) {
    setPrevActiveTabId(activeTab.id);
    if (activeTab.protocol === "graphql") {
      setRequestTab("graphql");
    } else if (activeTab.protocol === "websocket") {
      setRequestTab("ws-message");
    } else {
      setRequestTab("params");
    }
  } else if (!hasBody && requestTab === "body") {
    setRequestTab("params");
  }

  // Workspace tabs
  const workspaceTabs: TabItem[] = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        icon: (
          <span
            className={`api-badge api-badge-${tab.method.toLowerCase()}`}
            style={{
              fontSize: "8px",
              width: "auto",
              padding: "1px 4px",
              lineHeight: 1,
            }}
          >
            {tab.method}
          </span>
        ),
        closable: tabs.length > 1,
      })),
    [tabs]
  );

  const isMac =
    typeof window !== "undefined" &&
    /macintosh|mac os x/i.test(navigator.userAgent);

  // Loading state during store initialization or when no active tab exists
  if (!store.isInitialized || !activeTab) {
    return (
      <div className="api-tester-container flex items-center justify-center p-8">
        <LoadingState
          size="lg"
          title="Loading Workspace..."
          description="Please wait while we initialize the API Tester."
        />
      </div>
    );
  }

  return (
    <div className="api-tester-container">
      <ApiSidebar
        onOpenSettings={() => setShowEnvVarsModal(true)}
        onOpenLibrary={() => setShowLibraryModal(true)}
      />

      <main className="api-main">
        <WorkspaceTabBar
          tabs={workspaceTabs}
          activeTabId={store.activeTabId}
          onSelectTab={(id) => store.setActiveTab(id)}
          onCloseTab={(id) => store.removeTab(id)}
          onNewTab={() => store.addTab()}
          onRenameTab={(id, newName) => store.renameTab(id, newName)}
          onReorderTabs={(_activeId, _overId, oldIndex, newIndex) =>
            store.reorderTabs(oldIndex, newIndex)
          }
          onDuplicateTab={(id) => store.duplicateTab(id)}
          onCloseOthers={(id) => store.closeOtherTabs(id)}
          onCloseToRight={(id) => store.closeTabsToRight(id)}
          onCloseAll={() => store.closeAllTabs()}
          onCopyName={(id) => {
            const t = tabs.find((tab) => tab.id === id);
            if (t) navigator.clipboard.writeText(t.name);
          }}
          newTabTooltip="New Request Tab"
          rightContent={
            <>
              <SimpleTooltip content="API Preset Library (Ctrl/Cmd+Shift+L)">
                <button
                  className="toolbar-action-btn"
                  onClick={() => setShowLibraryModal(true)}
                  style={{ color: "var(--accent)" }}
                >
                  <Library className="h-3.5 w-3.5 text-accent" />
                  <span className="toolbar-action-label">Presets</span>
                </button>
              </SimpleTooltip>

              <div className="tabs-toolbar-sep" />
              <button
                ref={envBtnRef}
                onClick={() => {
                  if (!showEnvDropdown && envBtnRef.current) {
                    const rect = envBtnRef.current.getBoundingClientRect();
                    setEnvDropdownPos({
                      top: rect.bottom + 4,
                      right: window.innerWidth - rect.right,
                    });
                  }
                  setShowEnvDropdown(!showEnvDropdown);
                }}
                className="console-toggle-btn"
                style={{ gap: "6px" }}
              >
                <Globe className="h-3.5 w-3.5" />
                <span className="console-toggle-label">
                  {store.activeEnvironmentId
                    ? store.environments.find(
                        (e) => e.id === store.activeEnvironmentId
                      )?.name || "Global Environment"
                    : "Global Environment"}
                </span>
                <ChevronDown className="h-3 w-3" style={{ opacity: 0.5 }} />
              </button>

              <div className="tabs-toolbar-sep" />

              <SimpleTooltip content="Export all tabs to a ZIP file">
                <button
                  className="toolbar-action-btn"
                  onClick={() => setShowExportModal(true)}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="toolbar-action-label">Export</span>
                </button>
              </SimpleTooltip>
            </>
          }
        />

        {showEnvDropdown && (
          <>
            <div
              className="dropdown-backdrop"
              onClick={() => setShowEnvDropdown(false)}
            />
            <div
              ref={envDropdownRef}
              style={{
                position: "fixed",
                top: envDropdownPos.top,
                right: envDropdownPos.right,
                background: "var(--bg-1)",
                border: "1px solid var(--border-1)",
                borderRadius: "8px",
                padding: "6px",
                boxShadow:
                  "0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)",
                zIndex: 1000,
                minWidth: "180px",
              }}
            >
              <button
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  background:
                    store.activeEnvironmentId === null
                      ? "var(--bg-hover)"
                      : "transparent",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "var(--text-1)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  store.setActiveEnvironment(null);
                  setShowEnvDropdown(false);
                }}
                onMouseEnter={(e) => {
                  if (store.activeEnvironmentId !== null)
                    e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (store.activeEnvironmentId !== null)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <span>Global Only</span>
                {store.activeEnvironmentId === null && (
                  <Check className="h-3 w-3 text-accent" />
                )}
              </button>
              {store.environments.map((env) => (
                <button
                  key={env.id}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    background:
                      store.activeEnvironmentId === env.id
                        ? "var(--bg-hover)"
                        : "transparent",
                    border: "none",
                    borderRadius: "4px",
                    fontSize: "13px",
                    fontWeight: 500,
                    color: "var(--text-1)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    store.setActiveEnvironment(env.id);
                    setShowEnvDropdown(false);
                  }}
                  onMouseEnter={(e) => {
                    if (store.activeEnvironmentId !== env.id)
                      e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (store.activeEnvironmentId !== env.id)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span>{env.name}</span>
                  {store.activeEnvironmentId === env.id && (
                    <Check className="h-3 w-3 text-accent" />
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        <UrlBar
          activeTab={activeTab}
          isMac={isMac}
          showImportCurl={showImportCurl}
          showCodeSnippet={showCodeSnippet}
          onToggleImportCurl={() => setShowImportCurl(!showImportCurl)}
          onToggleCodeSnippet={() => setShowCodeSnippet(!showCodeSnippet)}
        />

        <CurlImportDrawer
          isOpen={showImportCurl}
          onClose={() => setShowImportCurl(false)}
          onImport={(curl) => store.importFromCurl(curl)}
        />

        <CodeSnippetDrawer
          isOpen={showCodeSnippet}
          onClose={() => setShowCodeSnippet(false)}
          activeTab={activeTab}
          currentThemeSetting={currentThemeSetting}
          handleEditorMount={handleEditorMount}
        />

        <div className="api-split-panes" ref={splitRef}>
          <RequestPane
            activeTab={activeTab}
            requestTab={requestTab}
            setRequestTab={setRequestTab}
            hasBody={hasBody}
            requestPaneHeight={requestPaneHeight}
            currentThemeSetting={currentThemeSetting}
            handleEditorMount={handleEditorMount}
            handleGraphqlEditorMount={handleGraphqlEditorMount}
            wsMessageText={wsMessageText}
            setWsMessageText={setWsMessageText}
          />

          <div
            className={`api-resize-handle ${
              isDraggingActive ? "api-resize-handle-active" : ""
            }`}
            onMouseDown={handleResizeStart}
          >
            <div className="api-resize-handle-bar" />
          </div>

          <ResponsePane
            activeTab={activeTab}
            currentThemeSetting={currentThemeSetting}
            handleEditorMount={handleEditorMount}
            onSend={() => store.sendRequest()}
          />
        </div>

        <ExportModal
          isOpen={showExportModal}
          onClose={() => setShowExportModal(false)}
        />

        <SettingsModal
          isOpen={showEnvVarsModal}
          onClose={() => setShowEnvVarsModal(false)}
        />

        <ApiLibraryModal
          isOpen={showLibraryModal}
          onClose={() => setShowLibraryModal(false)}
        />
      </main>
    </div>
  );
}
