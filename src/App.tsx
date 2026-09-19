// ============================================================
// App — Root application component
// ============================================================

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, lazy, Suspense } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TopLoadingBar } from "@/components/ui/top-loading-bar";
import { MainLayout } from "@/components/layout/MainLayout";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { ToastContainer } from "@/features/toast/ToastContainer";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useAppStore } from "@/stores/app.store";
import { VaultGuard } from "@/components/vault/VaultGuard";
import { useVaultStore } from "@/services/vault.service";

// Lazy-loaded routes for code splitting
const DashboardPage = lazy(() => import("@/pages/DashboardPage").then(m => ({ default: m.DashboardPage })));
const CompilerPage = lazy(() => import("@/pages/CompilerPage").then(m => ({ default: m.CompilerPage })));
const FormattersPage = lazy(() => import("@/pages/FormattersPage").then(m => ({ default: m.FormattersPage })));
const ComparatorsPage = lazy(() => import("@/pages/ComparatorsPage").then(m => ({ default: m.ComparatorsPage })));
const DiffCheckerPage = lazy(() => import("@/pages/DiffCheckerPage").then(m => ({ default: m.DiffCheckerPage })));
const LibraryPage = lazy(() => import("@/pages/LibraryPage").then(m => ({ default: m.LibraryPage })));
const DrawFlowPage = lazy(() => import("@/pages/DrawFlowPage").then(m => ({ default: m.DrawFlowPage })));
const ApiTesterPage = lazy(() => import("@/pages/ApiTesterPage").then(m => ({ default: m.ApiTesterPage })));
const ChatBotPage = lazy(() => import("@/pages/ChatBotPage").then(m => ({ default: m.ChatBotPage })));

import { bootstrapApp } from "@/services/bootstrap.service";

// Pre-initialize critical services and coordinate single loading screen
bootstrapApp();

// Pre-warm only lightweight lazy routes during idle time.
// Heavy routes (DrawFlows ~1.1MB, Library ~324KB, ApiTester ~180KB) are
// loaded on-demand when the user navigates to them.
if (typeof window !== "undefined") {
  const prewarm = () => {
    import("@/pages/DashboardPage");
    import("@/pages/CompilerPage");
    import("@/pages/FormattersPage");
    import("@/pages/ComparatorsPage");
    import("@/pages/DiffCheckerPage");
    import("@/pages/ChatBotPage");
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(prewarm, { timeout: 3000 });
  } else {
    setTimeout(prewarm, 1000);
  }
}

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center w-full h-full min-h-screen bg-bg-0 relative">
      <TopLoadingBar />
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

  // Poke vault auto-lock timer on user activity
  const pokeActivity = useVaultStore((s) => s.pokeActivity);
  useEffect(() => {
    const events = ["mousedown", "keydown", "scroll", "touchstart"] as const;
    const handler = () => pokeActivity();
    events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
    };
  }, [pokeActivity]);

  // Listen for storage quota exceeded event
  const addToast = useAppStore((s) => s.addToast);
  useEffect(() => {
    const handleQuotaExceeded = () => {
      addToast({
        message: "Storage Quota Full (~5MB): Browser local storage is full. Please close unused comparator/diff tabs or clear heavy inputs to continue saving changes.",
        type: "error",
        duration: 7000,
      });
    };
    window.addEventListener("intab:storage-quota-exceeded", handleQuotaExceeded);
    return () => {
      window.removeEventListener("intab:storage-quota-exceeded", handleQuotaExceeded);
    };
  }, [addToast]);

  return (
    <TooltipProvider delayDuration={300}>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<MainLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/chat" element={<ChatBotPage />} />
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
      <VaultGuard>
        <AppContent />
      </VaultGuard>
    </BrowserRouter>
  );
}

export default App;
