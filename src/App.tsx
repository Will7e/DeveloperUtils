// ============================================================
// App — Root application component
// ============================================================

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MainLayout } from "@/components/layout/MainLayout";
import { CompilerPage } from "@/pages/CompilerPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { FormattersPage } from "@/pages/FormattersPage";
import { ComparatorsPage } from "@/pages/ComparatorsPage";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { ToastContainer } from "@/features/toast/ToastContainer";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeepAlive } from "@/hooks/useKeepAlive";


function App() {
  useKeyboardShortcuts();
  useKeepAlive();


  return (
    <TooltipProvider delayDuration={300}>
      <BrowserRouter>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/compiler" element={<CompilerPage />} />
            <Route path="/formatters" element={<FormattersPage />} />
            <Route path="/comparators" element={<ComparatorsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>

        {/* Global Overlays */}
        <SettingsPanel />
        <CommandPalette />
        <ToastContainer />
      </BrowserRouter>
    </TooltipProvider>
  );
}

export default App;
