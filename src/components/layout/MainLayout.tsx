// ============================================================
// Main Layout — Collapsible navigation sidebar & content wrapper
// ============================================================

import { Link, useLocation, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useRef } from "react";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { InTabLogo } from "@/components/ui/intab-logo";
import {
  Home,
  Settings,
  Search,
  Code2,
  ChevronsLeft,
  ChevronsRight,
  FileCode,
  Columns,
  FileDiff,
  Library,
  GitFork,
  Globe,
  MessageSquareText,
  Sun,
  Moon,
  Coffee,
  Cloud,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { ShellActivityPresence } from "@/features/chat/components/ActivityRail";
import { useHandoffBridge } from "@/hooks/useHandoffBridge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavItemProps {
  to?: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  onClick?: () => void;
  labelClassName?: string;
  /** Animate label letters with a tiny staggered hop */
  staggered?: boolean;
}

function NavItem({ to, icon, label, active, collapsed, onClick, staggered }: NavItemProps) {
  const content = (
    <>
      <span className="nav-item-icon">{icon}</span>
      <span className={cn("nav-item-label", collapsed && "nav-item-label-hidden")}>
        {staggered
          ? label.split("").map((ch, i) => (
              <span
                key={`${i}-${ch}`}
                className="nav-item-letter-hop"
                style={{ animationDelay: `${i * 0.045}s` }}
              >
                {ch === " " ? "\u00A0" : ch}
              </span>
            ))
          : label}
      </span>
      {active && <div className="nav-item-indicator" />}
    </>
  );

  const className = cn("nav-item", active && "nav-item-active");

  // Collapsed items are icon-only, and a tooltip is hover-only — a screen
  // reader gets a nameless link. The label rides on the control itself so
  // the item is announceable in both states.
  const nameForCollapsed = collapsed ? label : undefined;

  // If it's a button (onClick), render button
  if (onClick) {
    const btn = (
      <button
        className={className}
        onClick={onClick}
        type="button"
        aria-label={nameForCollapsed}
      >
        {content}
      </button>
    );

    return collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="right">
          {label}
        </TooltipContent>
      </Tooltip>
    ) : (
      btn
    );
  }

  // Otherwise render Link
  const link = (
    <Link to={to!} className={className} aria-label={nameForCollapsed}>
      {content}
    </Link>
  );

  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
      </TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}

export function MainLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  /**
   * The agent's work, visible from anywhere in the app.
   *
   * The turn engine keeps running when this route unmounts, so before this the
   * agent could be editing the user's repository with nothing on screen admitting
   * it — no indicator, no completion notice, no way back. One pill in the chrome
   * and one notice at the end is the whole fix, and the pill's click is also the
   * way back: open the chat page and select the thread that is still working.
   */
  const chatVisible =
    location.pathname === "/chat" || location.pathname === "/chatbot";
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapse = useAppStore((s) => s.toggleSidebarCollapse);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const currentTheme = useAppStore((s) => s.editorSettings.theme);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);

  // Applies dashboard demo handoffs to the target tool, then navigates.
  useHandoffBridge();

  // ── Sidebar auto-collapse on idle ──────────────────────────
  // When enabled, the sidebar collapses after `delay` ms without any
  // pointer/keyboard activity anywhere in the window. Interacting with
  // the sidebar itself (or manually expanding it) keeps it open. The
  // timer only collapses — it never re-expands on its own.
  const sidebarAutoCollapse = useAppStore(
    (s) => s.editorSettings.sidebarAutoCollapse
  );
  const sidebarAutoCollapseDelay = useAppStore(
    (s) => s.editorSettings.sidebarAutoCollapseDelay
  );
  const collapsedRef = useRef(sidebarCollapsed);
  collapsedRef.current = sidebarCollapsed;

  useEffect(() => {
    if (!sidebarAutoCollapse) return;
    const delay = Math.max(5_000, sidebarAutoCollapseDelay);
    let timer: number | undefined;

    const collapse = () => {
      // Never slam the bar shut while the user's cursor is resting on it.
      if (collapsedRef.current) return;
      const bar = document.querySelector(".activity-bar");
      if (bar?.matches(":hover")) return;
      toggleSidebarCollapse();
    };
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(collapse, delay);
    };

    // Activity anywhere in the app resets the countdown.
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "pointermove",
      "keydown",
      "wheel",
      "focusin",
    ];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    reset();

    return () => {
      window.clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
  }, [sidebarAutoCollapse, sidebarAutoCollapseDelay, toggleSidebarCollapse]);

  const handleToggleTheme = () => {
    updateEditorSettings({ theme: currentTheme === "dark" ? "light" : "dark" });
  };

  const handleSupport = () => {
    const handle = (import.meta.env.VITE_BMC_HANDLE as string | undefined) || "intab";
    window.open(`https://buymeacoffee.com/${handle}`, "_blank", "noopener,noreferrer");
  };

  const handleCloudSync = () => {
    // Deep-link into Settings → Cloud Sync (event picked up by SettingsPanel)
    window.dispatchEvent(new CustomEvent("intab:open-settings", { detail: { tab: "cloud" } }));
    if (!settingsOpen) toggleSettings();
  };

  return (
    <div className="main-layout">
      {/* Collapsible Navigation Sidebar */}
      <nav
        className={cn("activity-bar", sidebarCollapsed && "activity-bar-collapsed")}
        aria-label="Main navigation"
      >
        {/* Brand / Logo — Click redirects to home */}
        {(() => {
          const brandLink = (
            <Link
              to="/"
              className="activity-bar-brand"
              aria-label="InTab - Home"
            >
              <div className="activity-logo">
                <InTabLogo size={28} />
              </div>
              <span className={cn("activity-brand-text", sidebarCollapsed && "activity-brand-text-hidden")}>
                Tab
              </span>
            </Link>
          );

          return sidebarCollapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>{brandLink}</TooltipTrigger>
              <TooltipContent side="right">
                InTab Home
              </TooltipContent>
            </Tooltip>
          ) : (
            brandLink
          );
        })()}

        {/* Main Navigation */}
        <div className="activity-bar-nav">
          <NavItem
            to="/"
            icon={<Home className="h-[18px] w-[18px]" />}
            label="Dashboard"
            active={location.pathname === "/"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/chat"
            icon={<MessageSquareText className="h-[18px] w-[18px]" />}
            label="Agents"
            active={location.pathname === "/chat" || location.pathname === "/chatbot"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/compiler"
            icon={<Code2 className="h-[18px] w-[18px]" />}
            label="Compiler"
            active={location.pathname === "/compiler"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/formatters"
            icon={<FileCode className="h-[18px] w-[18px]" />}
            label="Formatters"
            active={location.pathname === "/formatters"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/diff"
            icon={<FileDiff className="h-[18px] w-[18px]" />}
            label="Diff Check"
            active={location.pathname === "/diff"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/comparators"
            icon={<Columns className="h-[18px] w-[18px]" />}
            label="Comparators"
            active={location.pathname === "/comparators"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/api-tester"
            icon={<Globe className="h-[18px] w-[18px]" />}
            label="API Tester"
            active={location.pathname === "/api-tester"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/library"
            icon={<Library className="h-[18px] w-[18px]" />}
            label="Library"
            active={location.pathname === "/library"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            to="/drawflows"
            icon={<GitFork className="h-[18px] w-[18px]" />}
            label="DrawFlows"
            active={location.pathname === "/drawflows" || location.pathname === "/workflows"}
            collapsed={sidebarCollapsed}
          />

          <NavItem
            icon={<Search className="h-[18px] w-[18px]" />}
            label="Commands"
            collapsed={sidebarCollapsed}
            onClick={toggleCommandPalette}
          />
        </div>

        {/* A running turn is a fact about the app, not about one route: the pill
            stays visible while the user is in the compiler, the diff checker or
            anywhere else, and clicking it goes back to the thread doing the work.
            Mounted unconditionally because its other half is the completion
            notice, which has to fire while the pill itself is hidden. */}
        <ShellActivityPresence
          chatVisible={chatVisible}
          showPill={!chatVisible}
          onOpen={(conversationId) => {
            useChatStore.getState().selectConversation(conversationId);
            navigate("/chat");
          }}
        />

        {/* Cloud Sync — just above the footer divider */}
        <div className="activity-bar-cloudsync">
          <NavItem
            icon={<Cloud className="h-[18px] w-[18px]" />}
            label="Cloud Sync"
            collapsed={sidebarCollapsed}
            onClick={handleCloudSync}
          />
        </div>

        {/* Bottom Actions */}
        <div className="activity-bar-bottom">
          <div className="activity-bar-divider" />

          <NavItem
            icon={<Coffee className="h-[18px] w-[18px]" />}
            label="Support InTab"
            collapsed={sidebarCollapsed}
            onClick={handleSupport}
            staggered
          />

          <NavItem
            icon={currentTheme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            label={currentTheme === "dark" ? "Light Mode" : "Dark Mode"}
            collapsed={sidebarCollapsed}
            onClick={handleToggleTheme}
          />

          <NavItem
            icon={<Settings className="h-[18px] w-[18px]" />}
            label="Settings"
            collapsed={sidebarCollapsed}
            onClick={toggleSettings}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="nav-collapse-btn"
                onClick={toggleSidebarCollapse}
                type="button"
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!sidebarCollapsed}
              >
                {sidebarCollapsed ? (
                  <ChevronsRight className="h-4 w-4" />
                ) : (
                  <>
                    <ChevronsLeft className="h-4 w-4" />
                    <span className="nav-collapse-label">Collapse</span>
                  </>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            </TooltipContent>
          </Tooltip>
        </div>
      </nav>

      {/* Main Content View */}
      <main className="main-content relative">
        <Suspense
          fallback={
            <div className="flex-1 flex flex-col w-full h-full">
              <PageSkeleton />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
