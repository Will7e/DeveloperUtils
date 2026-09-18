// ============================================================
// Dashboard Page — Ultra-Clean Zero-Scroll Bento Console
// ============================================================

import { Link } from "react-router-dom";
import {
  Code2,
  Globe,
  GitFork,
  Columns,
  FileDiff,
  FileCode,
  BookOpen,
  ShieldCheck,
  ArrowUpRight,
} from "lucide-react";
import { InTabLogo } from "@/components/ui/intab-logo";

interface ToolItem {
  id: string;
  to: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  iconColor: string;
  glowColor: string;
  pills: string[];
  spanClass: string;
}

const TOOLS: ToolItem[] = [
  // Top Row: 3 Workspace Studios (each spans 4 columns out of 12)
  {
    id: "compiler",
    to: "/compiler",
    title: "Code Compiler",
    description: "Write and run code in your browser with live HTML preview.",
    icon: <Code2 className="h-4 w-4" />,
    iconColor: "var(--accent)",
    glowColor: "rgba(99, 102, 241, 0.18)",
    pills: ["JS / TS", "HTML / CSS", "Live Run"],
    spanClass: "dash-col-4",
  },
  {
    id: "api-tester",
    to: "/api-tester",
    title: "API Tester",
    description: "Send HTTP requests, test endpoints, and save environment variables.",
    icon: <Globe className="h-4 w-4" />,
    iconColor: "#a855f7",
    glowColor: "rgba(168, 85, 247, 0.18)",
    pills: ["REST Client", "Headers & Auth", "History"],
    spanClass: "dash-col-4",
  },
  {
    id: "drawflows",
    to: "/drawflows",
    title: "DrawFlow Studio",
    description: "Build flowcharts, draw system architectures, and export Mermaid charts.",
    icon: <GitFork className="h-4 w-4" />,
    iconColor: "#2dd4bf",
    glowColor: "rgba(45, 212, 191, 0.18)",
    pills: ["Flowcharts", "Architecture", "Mermaid"],
    spanClass: "dash-col-4",
  },

  // Bottom Row: 4 Essential Utilities (each spans 3 columns out of 12)
  {
    id: "comparators",
    to: "/comparators",
    title: "Comparators",
    description: "Compare lists, diff JSON objects, and find missing .env keys.",
    icon: <Columns className="h-4 w-4" />,
    iconColor: "#0ea5e9",
    glowColor: "rgba(14, 165, 233, 0.18)",
    pills: ["Lists & Sets", "JSON Diff", ".env Keys"],
    spanClass: "dash-col-3",
  },
  {
    id: "diff",
    to: "/diff",
    title: "Diff Check",
    description: "Compare text and code side-by-side with highlighted changes.",
    icon: <FileDiff className="h-4 w-4" />,
    iconColor: "#f472b6",
    glowColor: "rgba(244, 114, 182, 0.18)",
    pills: ["Side-by-Side", "Unified", "Syntax"],
    spanClass: "dash-col-3",
  },
  {
    id: "formatters",
    to: "/formatters",
    title: "Formatters",
    description: "Clean up, validate, and minify messy JSON and XML data.",
    icon: <FileCode className="h-4 w-4" />,
    iconColor: "#10b981",
    glowColor: "rgba(16, 185, 129, 0.18)",
    pills: ["JSON & XML", "Prettify", "Minify"],
    spanClass: "dash-col-3",
  },
  {
    id: "library",
    to: "/library",
    title: "API Library",
    description: "Search ServiceNow API classes, documentation, and code examples.",
    icon: <BookOpen className="h-4 w-4" />,
    iconColor: "#f59e0b",
    glowColor: "rgba(245, 158, 11, 0.18)",
    pills: ["ServiceNow", "1,500+ APIs"],
    spanClass: "dash-col-3",
  },
];

export function DashboardPage() {
  return (
    <div className="dash-page">
      <div className="dash-container">
        {/* Compact Hero Section */}
        <div className="dash-hero">
          <div className="dash-hero-logo-wrap">
            <div className="dash-hero-logo-glow" />
            <InTabLogo size={42} className="dash-hero-icon" />
          </div>
          <h1 className="dash-hero-title">
            Everyday developer tools, right in your{" "}
            <span className="dash-hero-accent">browser</span>
          </h1>
          <p className="dash-hero-subtitle">
            Format JSON, compare files, test APIs, and write code directly on your machine.
          </p>
        </div>

        {/* Bento Grid */}
        <div className="dash-bento-grid">
          {TOOLS.map((tool) => (
            <Link
              key={tool.id}
              to={tool.to}
              className={`dash-tool-card ${tool.spanClass}`}
              style={{ "--card-glow": tool.glowColor } as React.CSSProperties}
            >
              <div
                className="dash-card-glow"
                style={{ background: tool.glowColor }}
              />

              <div className="dash-card-top">
                <div className="dash-card-title-group">
                  <div
                    className="dash-card-icon-wrap"
                    style={{
                      background: tool.glowColor,
                      color: tool.iconColor,
                    }}
                  >
                    {tool.icon}
                  </div>
                  <h3 className="dash-card-title">{tool.title}</h3>
                </div>
                <div className="dash-card-arrow-wrap">
                  <ArrowUpRight className="dash-card-arrow" />
                </div>
              </div>

              <p className="dash-card-desc">{tool.description}</p>

              <div className="dash-card-pills">
                {tool.pills.map((pill, i) => (
                  <span key={i} className="dash-card-pill">
                    {pill}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>

        {/* Minimal Bottom Bar */}
        <div className="dash-footer-bar">
          <div className="dash-footer-item">
            <span className="dash-status-dot" />
            <span>100% In-Browser Execution</span>
          </div>
          <span className="dash-footer-divider">•</span>
          <div className="dash-footer-item">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            <span>Encrypted at Rest</span>
          </div>
          <span className="dash-footer-divider">•</span>
          <div className="dash-footer-item">
            <kbd className="dash-kbd">⌘K</kbd>
            <span>Command Palette</span>
          </div>
        </div>
      </div>
    </div>
  );
}
