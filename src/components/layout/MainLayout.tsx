// ============================================================
// Main Layout — Global navigation sidebar & content wrapper
// ============================================================

import { Link, useLocation, Outlet } from "react-router-dom";
import { Terminal, Home, Settings, Search, User, Zap, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}

function NavItem({ to, icon, label, active }: NavItemProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={to}
          className={cn(
            "nav-item",
            active && "nav-item-active"
          )}
        >
          {icon}
          {active && <div className="nav-item-indicator" />}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" className="bg-popover border-border shadow-xl">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function MainLayout() {
  const location = useLocation();
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);

  return (
    <div className="main-layout">
      {/* Activity Bar (Global Navigation Sidebar) */}
      <nav className="activity-bar">
        <div className="activity-bar-top">
          <div className="activity-logo">
            <Zap className="h-5 w-5 text-accent" />
          </div>
          
          <NavItem 
            to="/" 
            icon={<Home className="h-5 w-5" />} 
            label="Dashboard" 
            active={location.pathname === "/"} 
          />
          
          <NavItem 
            to="/compiler" 
            icon={<Code2 className="h-5 w-5" />} 
            label="Compiler" 
            active={location.pathname === "/compiler"} 
          />

          <button 
            className="nav-item" 
            onClick={toggleCommandPalette}
            title="Search Commands"
          >
            <Search className="h-5 w-5" />
          </button>
        </div>

        <div className="activity-bar-bottom">
          <NavItem 
            to="/account" 
            icon={<User className="h-5 w-5" />} 
            label="Account" 
            active={location.pathname === "/account"} 
          />
          
          <button 
            className="nav-item" 
            onClick={toggleSettings}
            title="Settings"
          >
            <Settings className="h-5 w-5" />
          </button>
        </div>
      </nav>

      {/* Main Content View */}
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
