// ============================================================
// Dashboard Page
// ============================================================

import { Link } from "react-router-dom";
import {
  Code2,
  Globe,
  PenTool,
  Columns,
  FileDiff,
  FileCode,
  BookOpen,
  ShieldCheck,
  Check,
} from "lucide-react";
import { InTabLogo } from "@/components/ui/intab-logo";
import {
  CompilerPreview,
  ApiTesterPreview,
  DrawFlowPreview,
  ComparatorsPreview,
  DiffPreview,
  FormattersPreview,
  LibraryPreview,
} from "@/features/dashboard/previews";interface ToolFeature {
  id: string;
  to: string;
  badge: string;
  title: string;
  description: string;
  highlights: string[];
  icon: React.ReactNode;
  windowTitle: string;
  preview: React.ReactNode;
}

const TOOLS: ToolFeature[] = [
  // Feature 1: Code Compiler (Feature Left, Text Right)
  {
    id: "compiler",
    to: "/compiler",
    badge: "TypeScript and JavaScript",
    title: "Code Compiler and Runner",
    description:
      "Write and execute TypeScript or JavaScript directly in your browser. Test functions, inspect console logs, and view return values without configuring a local project.",
    highlights: [
      "Executes code locally using your browser JavaScript runtime",
      "Live console logging with return value inspection",
      "Monaco code editor with syntax highlighting and auto format",
    ],
    icon: <Code2 className="h-3.5 w-3.5" />,
    windowTitle: "script.ts",
    preview: <CompilerPreview />,
  },

  // Feature 2: API Tester (Text Left, Feature Right)
  {
    id: "api-tester",
    to: "/api-tester",
    badge: "HTTP Client",
    title: "REST API Client",
    description:
      "Send HTTP requests directly from your browser. Inspect response payloads, check headers and status codes, and test endpoints without sending your requests through third party servers.",
    highlights: [
      "Send GET, POST, PUT, DELETE, and custom HTTP requests",
      "Inspect formatted JSON responses, headers, and latency times",
      "Manage query parameters, request headers, and environments",
    ],
    icon: <Globe className="h-3.5 w-3.5" />,
    windowTitle: "request.json",
    preview: <ApiTesterPreview />,
  },

  // Feature 3: Excalidraw Studio (Feature Left, Text Right)
  {
    id: "drawflows",
    to: "/drawflows",
    badge: "Diagrams and Whiteboard",
    title: "DrawFlow Diagrams",
    description:
      "Sketch system architectures, flowcharts, and notes on an infinite canvas. Connect components with dynamic lines, customize styles, and export diagrams as SVG or PNG images.",
    highlights: [
      "Draw system architectures, rectangles, diamonds, and freehand notes",
      "Connect components with dynamic arrows that follow your shapes",
      "Export finished diagrams to clipboard, SVG, or PNG format",
    ],
    icon: <PenTool className="h-3.5 w-3.5" />,
    windowTitle: "architecture.canvas",
    preview: <DrawFlowPreview />,
  },

  // Feature 4: Formatters (Text Left, Feature Right)
  {
    id: "formatters",
    to: "/formatters",
    badge: "Prettifier and Minifier",
    title: "Code Formatters",
    description:
      "Format and minify JSON, XML, SQL, and HTML documents. Fix indentation, validate syntax, view file size savings, and copy clean output in one click.",
    highlights: [
      "Prettify unformatted payloads with two space or four space indentation",
      "Minify data into a single compact line to reduce payload size",
      "Flags syntax errors with line numbers and copy output instantly",
    ],
    icon: <FileCode className="h-3.5 w-3.5" />,
    windowTitle: "data.json",
    preview: <FormattersPreview />,
  },

  // Feature 5: Diff Checker (Feature Left, Text Right)
  {
    id: "diff",
    to: "/diff",
    badge: "Text and Code Comparison",
    title: "Diff Checker",
    description:
      "Compare two files or text blocks side by side. Highlights added, removed, and changed lines so you can review pull requests, configs, and code revisions quickly.",
    highlights: [
      "Side by side split view and unified line comparison modes",
      "Highlights insertions and deletions with line numbers and diff markers",
      "Supports syntax highlighting, whitespace ignore, and preset examples",
    ],
    icon: <FileDiff className="h-3.5 w-3.5" />,
    windowTitle: "diff_comparison.ts",
    preview: <DiffPreview />,
  },

  // Feature 6: Comparators and .env Audit (Text Left, Feature Right)
  {
    id: "comparators",
    to: "/comparators",
    badge: "Config and List Audit",
    title: "Environment and List Comparator",
    description:
      "Compare environment files and lists to find discrepancies. Quickly identify missing variables between staging and production environments or find common items between lists.",
    highlights: [
      "Audit environment variables to find missing or mismatched keys",
      "List operations including union, intersection, and unique item filters",
      "Runs completely on your machine so secrets and tokens remain private",
    ],
    icon: <Columns className="h-3.5 w-3.5" />,
    windowTitle: "env_audit.conf",
    preview: <ComparatorsPreview />,
  },

  // Feature 7: ServiceNow API Hub (Feature Left, Text Right)
  {
    id: "library",
    to: "/library",
    badge: "API Reference and Snippets",
    title: "ServiceNow API Reference",
    description:
      "Search official ServiceNow API classes, methods, and parameters offline. View syntax highlighted examples for GlideRecord, GlideSystem, and RESTMessageV2 with copy ready code snippets.",
    highlights: [
      "Quick search across Scoped and Global ServiceNow JavaScript APIs",
      "Includes working snippets for database queries, web services, and dates",
      "Copy code snippets directly into your script editor",
    ],
    icon: <BookOpen className="h-3.5 w-3.5" />,
    windowTitle: "servicenow_reference.js",
    preview: <LibraryPreview />,
  },
];

export function DashboardPage() {
  return (
    <div className="dash-page">
      <div className="dash-container">
        {/* Hero Section */}
        <div className="dash-hero">
          <div className="dash-hero-logo-wrap">
            <div className="dash-hero-logo-glow" />
            <InTabLogo size={46} className="dash-hero-icon" />
          </div>
          <h1 className="dash-hero-title">
            Private developer utilities that run locally in your{" "}
            <span className="dash-hero-accent">tab</span>
          </h1>
          <p className="dash-hero-subtitle">
            No server calls, no tracking. Your data stays{" "}
            <span className="dash-hero-highlight">secure and encrypted</span> on your device.
          </p>
        </div>

        {/* Alternating Zig Zag Feature Showcase */}
        <div className="dash-zigzag-container">
          {TOOLS.map((tool, index) => {
            const isReversed = index % 2 !== 0;

            return (
              <div key={tool.id}>
                <section
                  id={tool.id}
                  className={`dash-zigzag-row ${isReversed ? "is-reversed" : ""}`}
                >
                  {/* Live Interactive Window Mockup */}
                  <div className="dash-zigzag-preview">
                    <div className="dash-window-mockup">
                      {/* Mockup Titlebar */}
                      <div className="dash-window-titlebar">
                        <div className="dash-window-dots">
                          <span className="dash-window-dot dot-red" />
                          <span className="dash-window-dot dot-yellow" />
                          <span className="dash-window-dot dot-green" />
                        </div>
                        <div className="dash-window-title">
                          <span className="dash-window-url">{tool.windowTitle}</span>
                        </div>
                      </div>

                      {/* Interactive Sandbox Body */}
                      <div className="dash-window-body">{tool.preview}</div>
                    </div>
                  </div>

                  {/* Feature Narrative Column */}
                  <div className="dash-zigzag-content">
                    <div className="dash-feature-badge-pill">
                      <span className="dash-feature-badge-icon">{tool.icon}</span>
                      <span>{tool.badge}</span>
                    </div>

                    <h2 className="dash-feature-title">
                      <Link to={tool.to} className="dash-feature-title-link">
                        {tool.title}
                      </Link>
                    </h2>
                    <p className="dash-feature-desc">{tool.description}</p>

                    <ul className="dash-feature-highlights">
                      {tool.highlights.map((item, hIdx) => (
                        <li key={hIdx} className="dash-feature-highlight-item">
                          <div className="dash-highlight-check">
                            <Check className="h-3 w-3" strokeWidth={2.5} />
                          </div>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>

                {index < TOOLS.length - 1 && (
                  <div className="dash-zigzag-divider" style={{ marginTop: "72px" }} />
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom Security and Tech Trust Bar */}
        <div className="dash-footer-bar">
          <div className="dash-footer-item">
            <span className="dash-status-dot" />
            <span>Local browser execution</span>
          </div>
          <span className="dash-footer-divider">•</span>
          <div className="dash-footer-item">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            <span>Encrypted locally on your device</span>
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
