// ============================================================
// App — Root application component
// ============================================================

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MainLayout } from "@/components/layout/MainLayout";
import { CompilerPage } from "@/pages/CompilerPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { FormattersPage } from "@/pages/FormattersPage";
import { ComparatorsPage } from "@/pages/ComparatorsPage";
import { DiffCheckerPage } from "@/pages/DiffCheckerPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { WorkflowPage } from "@/pages/WorkflowPage";
import { ApiTesterPage } from "@/pages/ApiTesterPage";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { ToastContainer } from "@/features/toast/ToastContainer";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeepAlive } from "@/hooks/useKeepAlive";
import { useAppStore } from "@/stores/app.store";


function AppContent() {
  useKeyboardShortcuts();
  useKeepAlive();

  // Apply light/dark theme class to document root
  const theme = useAppStore((s) => s.editorSettings.theme);
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  return (
    <TooltipProvider delayDuration={300}>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/compiler" element={<CompilerPage />} />
          <Route path="/formatters" element={<FormattersPage />} />
          <Route path="/comparators" element={<ComparatorsPage />} />
          <Route path="/diff" element={<DiffCheckerPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/workflows" element={<WorkflowPage />} />
          <Route path="/api-tester" element={<ApiTesterPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>

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
