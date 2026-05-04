// ============================================================
// App — Root application component
// ============================================================

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toolbar } from "@/features/toolbar/Toolbar";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { EditorTabs } from "@/features/editor/EditorTabs";
import { OutputPanel } from "@/features/output/OutputPanel";
import { HtmlPreview } from "@/features/preview/HtmlPreview";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/app.store";
import { useEffect, useRef } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";

function App() {
  useKeyboardShortcuts();

  const activeFileId = useAppStore((s) => s.activeFileId);
  const files = useAppStore((s) => s.files);
  const activeFile = files.find((f) => f.id === activeFileId);
  const isHtml = activeFile?.language === "html";

  const outputPanelOpen = useAppStore((s) => s.outputPanelOpen);
  const toggleOutputPanel = useAppStore((s) => s.toggleOutputPanel);
  const outputPanelRef = useRef<PanelImperativeHandle>(null);

  // Sync panel state with store
  useEffect(() => {
    const panel = outputPanelRef.current;
    if (panel) {
      if (outputPanelOpen) {
        panel.expand();
      } else {
        panel.collapse();
      }
    }
  }, [outputPanelOpen]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-root">
        {/* Top toolbar */}
        <Toolbar />

        {/* Main content area */}
        <div className="app-main">
          {/* Sidebar */}
          <Sidebar />

          {/* Editor + Output Area */}
          <div className="app-editor-area">
            <ResizablePanelGroup orientation="horizontal">
              <ResizablePanel defaultSize={70} minSize={30}>
                <div className="app-editor-section">
                  {/* Tabs */}
                  <EditorTabs />

                  {/* Editor + optional HTML preview */}
                  <div className="app-editor-content">
                    <div className={isHtml ? "editor-split" : "editor-full"}>
                      <CodeEditor />
                    </div>
                    {isHtml && <HtmlPreview />}
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle />

              <ResizablePanel 
                panelRef={outputPanelRef}
                defaultSize={30} 
                minSize={10}
                collapsible
                onCollapse={() => {
                  if (outputPanelOpen) toggleOutputPanel();
                }}
                onExpand={() => {
                  if (!outputPanelOpen) toggleOutputPanel();
                }}
              >
                {/* Output */}
                <OutputPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </div>

        {/* Settings overlay */}
        <SettingsPanel />

        {/* Status bar */}
        <div className="status-bar">
          <div className="status-left">
            <span className="status-item">
              ⚡ CodeForge
            </span>
            {activeFile && (
              <>
                <span className="status-separator">|</span>
                <span className="status-item">
                  {activeFile.language.toUpperCase()}
                </span>
                <span className="status-separator">|</span>
                <span className="status-item">
                  Ln {activeFile.content.split("\n").length}
                </span>
              </>
            )}
          </div>
          <div className="status-right">
            <span className="status-item status-shortcut">
              Ctrl+Enter: Run
            </span>
            <span className="status-separator">|</span>
            <span className="status-item status-shortcut">
              Ctrl+B: Sidebar
            </span>
            <span className="status-separator">|</span>
            <span className="status-item status-shortcut">
              Ctrl+J: Output
            </span>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
