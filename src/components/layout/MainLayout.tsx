// ============================================================
// Main Layout — Collapsible navigation sidebar & content wrapper
// ============================================================

import { Link, useLocation, Outlet } from "react-router-dom";
import {
  Home,
  Settings,
  Search,
  Code2,
  Zap,
  ChevronsLeft,
  ChevronsRight,
  FileCode,
  Columns,
  FileDiff,
  Library,
  GitFork,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
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
}

function NavItem({ to, icon, label, active, collapsed, onClick }: NavItemProps) {
  const content = (
    <>
      <span className="nav-item-icon">{icon}</span>
      <span className={cn("nav-item-label", collapsed && "nav-item-label-hidden")}>
        {label}
      </span>
      {active && <div className="nav-item-indicator" />}
    </>
  );

  const className = cn("nav-item", active && "nav-item-active");

  // If it's a button (onClick), render button
  if (onClick) {
    const btn = (
      <button className={className} onClick={onClick} type="button">
        {content}
      </button>
    );

    return collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="right" className="bg-popover border-border shadow-xl">
          {label}
        </TooltipContent>
      </Tooltip>
    ) : (
      btn
    );
  }

  // Otherwise render Link
  const link = (
    <Link to={to!} className={className}>
      {content}
    </Link>
  );

  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="bg-popover border-border shadow-xl">
        {label}
      </TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}

export function MainLayout() {
  const location = useLocation();
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapse = useAppStore((s) => s.toggleSidebarCollapse);

  return (
    <div className="main-layout">
      {/* Collapsible Navigation Sidebar */}
      <nav className={cn("activity-bar", sidebarCollapsed && "activity-bar-collapsed")}>
        {/* Brand */}
        <div className="activity-bar-brand">
          <div className="activity-logo">
            <Zap className="h-5 w-5 text-accent" />
          </div>
          <span className={cn("activity-brand-text", sidebarCollapsed && "activity-brand-text-hidden")}>
            DevUtils
          </span>
        </div>

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

        {/* Bottom Actions */}
        <div className="activity-bar-bottom">
          <div className="activity-bar-divider" />

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
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
