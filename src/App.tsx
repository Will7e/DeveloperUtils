// ============================================================
// App — Root application component
// ============================================================

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, lazy, Suspense } from "react";
import { loader } from "@monaco-editor/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LoadingState } from "@/components/ui/loading-state";
import { TopLoadingBar } from "@/components/ui/top-loading-bar";
import { MainLayout } from "@/components/layout/MainLayout";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { ToastContainer } from "@/features/toast/ToastContainer";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/app.store";
import { setupMonacoTheme } from "@/utils/monaco-theme";

// Lazy-loaded routes for code splitting
const DashboardPage = lazy(() => import("@/pages/DashboardPage").then(m => ({ default: m.DashboardPage })));
const CompilerPage = lazy(() => import("@/pages/CompilerPage").then(m => ({ default: m.CompilerPage })));
const FormattersPage = lazy(() => import("@/pages/FormattersPage").then(m => ({ default: m.FormattersPage })));
const ComparatorsPage = lazy(() => import("@/pages/ComparatorsPage").then(m => ({ default: m.ComparatorsPage })));
const DiffCheckerPage = lazy(() => import("@/pages/DiffCheckerPage").then(m => ({ default: m.DiffCheckerPage })));
const LibraryPage = lazy(() => import("@/pages/LibraryPage").then(m => ({ default: m.LibraryPage })));
const DrawFlowPage = lazy(() => import("@/pages/DrawFlowPage").then(m => ({ default: m.DrawFlowPage })));
const ApiTesterPage = lazy(() => import("@/pages/ApiTesterPage").then(m => ({ default: m.ApiTesterPage })));

// Pre-initialize Monaco and register custom themes early to prevent initial light-theme fallback
loader.init().then((monaco) => {
  setupMonacoTheme(monaco);
});

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center w-full h-full min-h-screen bg-bg-0 relative">
      <TopLoadingBar />
      <LoadingState
        fullPage
        message="Loading workspace..."
        description="Initializing workspace environment"
      />
    </div>
  );
}

function AppContent() {
  useKeyboardShortcuts();

  // Apply light/dark theme class and color-scheme to document root
  const theme = useAppStore((s) => s.editorSettings.theme);
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  return (
    <TooltipProvider delayDuration={300}>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/compiler" element={<CompilerPage />} />
            <Route path="/formatters" element={<FormattersPage />} />
            <Route path="/comparators" element={<ComparatorsPage />} />
            <Route path="/diff" element={<DiffCheckerPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/drawflows" element={<DrawFlowPage />} />
            <Route path="/workflows" element={<Navigate to="/drawflows" replace />} />
            <Route path="/api-tester" element={<ApiTesterPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>

      {/* Global Overlays */}
      <SettingsPanel />
      <CommandPalette />
      <ToastContainer />
    </TooltipProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

export default App;
