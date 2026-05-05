// ============================================================
// Dashboard Page — Premium landing with tool navigation
// ============================================================

import { Link } from "react-router-dom";
import { Zap, Code2, Terminal, Cpu, Globe, ArrowRight, FileCode, Rocket, Columns, BookOpen, GitFork } from "lucide-react";

interface ToolCardProps {
  to?: string;
  icon: React.ReactNode;
  iconColor: string;
  glowColor: string;
  title: string;
  description: string;
  available?: boolean;
}

function ToolCard({ to, icon, iconColor, glowColor, title, description, available = false }: ToolCardProps) {
  const content = (
    <>
      <div className="dash-card-header">
        <div className="dash-card-icon" style={{ background: glowColor }}>
          <span style={{ color: iconColor }}>{icon}</span>
        </div>
        {!available && <span className="dash-card-badge">Coming Soon</span>}
        {available && <ArrowRight className="dash-card-arrow" />}
      </div>
      <div className="dash-card-body">
        <h3 className="dash-card-title">{title}</h3>
        <p className="dash-card-desc">{description}</p>
      </div>
    </>
  );

  if (available && to) {
    return (
      <Link to={to} className="dash-card dash-card-active">
        {content}
      </Link>
    );
  }

  return (
    <div className="dash-card dash-card-disabled">
      {content}
    </div>
  );
}

export function DashboardPage() {
  return (
    <div className="dash-page">
      <div className="dash-container">
        {/* Hero Section */}
        <div className="dash-hero">
          <div className="dash-hero-badge">
            <Zap className="h-3.5 w-3.5" />
            <span>Developer Workspace</span>
          </div>
          <h1 className="dash-hero-title">
            Welcome to <span className="dash-hero-accent">DevUtils</span>
          </h1>
          <p className="dash-hero-subtitle">
            The elite workspace where your code runs fast, your bugs hide in fear, and "it works on my machine" becomes a universal truth.
          </p>
        </div>

        {/* Stats Row */}
        <div className="dash-stats">
          <div className="dash-stat">
            <span className="dash-stat-value">5</span>
            <span className="dash-stat-label">Languages</span>
          </div>
          <div className="dash-stat-divider" />
          <div className="dash-stat">
            <span className="dash-stat-value">
              <Globe className="h-4 w-4" />
            </span>
            <span className="dash-stat-label">Cloud Execution</span>
          </div>
          <div className="dash-stat-divider" />
          <div className="dash-stat">
            <span className="dash-stat-value">∞</span>
            <span className="dash-stat-label">Projects</span>
          </div>
        </div>

        {/* Available Features Section */}
        <div className="dash-section">
          <div className="dash-section-header">
            <Rocket className="h-4 w-4 text-accent" />
            <h2>Available Features</h2>
          </div>
          <div className="dash-grid">
            <ToolCard
              to="/compiler"
              icon={<Code2 className="h-5 w-5" />}
              iconColor="#0ea5e9"
              glowColor="rgba(14, 165, 233, 0.12)"
              title="Cloud Compiler"
              description="Write and run code in 5+ languages directly in the browser with Monaco editor and live HTML preview."
              available
            />

            <ToolCard
              to="/formatters"
              icon={<FileCode className="h-5 w-5" />}
              iconColor="#a3e635"
              glowColor="rgba(163, 230, 53, 0.12)"
              title="Formatters"
              description="Instantly beautify or minify JSON and XML with syntax highlighting and interactive tree views."
              available
            />
            <ToolCard
              to="/comparators"
              icon={<Columns className="h-5 w-5" />}
              iconColor="#38bdf8"
              glowColor="rgba(56, 189, 248, 0.12)"
              title="List Comparator"
              description="Compare two text lists side by side. Instantly spot unique items, common entries, and differences."
              available
            />
            <ToolCard
              to="/library"
              icon={<BookOpen className="h-5 w-5" />}
              iconColor="#c084fc"
              glowColor="rgba(192, 132, 252, 0.12)"
              title="API Library"
              description="Searchable ServiceNow API reference — 129 classes, 741 methods with real-world code examples."
              available
            />
            <ToolCard
              to="/workflows"
              icon={<GitFork className="h-5 w-5" />}
              iconColor="#2dd4bf"
              glowColor="rgba(45, 212, 191, 0.12)"
              title="Workflow Designer"
              description="Visual drag-and-drop workflow diagram builder with custom nodes, animated edges, and JSON export."
              available
            />
          </div>
        </div>

        {/* Future Roadmap Section */}
        <div className="dash-section">
          <div className="dash-section-header">
            <Zap className="h-4 w-4 text-text-3" />
            <h2>Future Roadmap</h2>
          </div>
          <div className="dash-grid">
            <ToolCard
              icon={<Terminal className="h-5 w-5" />}
              iconColor="#38bdf8"
              glowColor="rgba(56, 189, 248, 0.12)"
              title="Terminal Shell"
              description="Direct access to a sandboxed environment for rapid CLI prototyping."
            />

            <ToolCard
              icon={<Zap className="h-5 w-5" />}
              iconColor="#2dd4bf"
              glowColor="rgba(45, 212, 191, 0.12)"
              title="API Tester"
              description="A premium alternative to Postman for rapid API exploration and debugging."
            />

            <ToolCard
              icon={<Cpu className="h-5 w-5" />}
              iconColor="#0ea5e9"
              glowColor="rgba(14, 165, 233, 0.12)"
              title="System Monitor"
              description="Real-time visualization of resource allocation and performance metrics."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
