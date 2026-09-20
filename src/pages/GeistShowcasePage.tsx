import React, { useState } from "react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  LoadingDots,
  StatusDot,
  DotsMenu,
} from "@/components/ui/dots";
import { SearchInput } from "@/components/ui/search-input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumbs,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from "@/components/ui/breadcrumbs";
import { CodeBlock, Snippet } from "@/components/ui/code-block";
import { Separator } from "@/components/ui/separator";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Toggle } from "@/components/ui/toggle";
import { SegmentedSwitch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app.store";
import {
  Sparkles,
  Shield,
  Zap,
  Globe,
  CheckCircle,
  FileCode,
  Folder,
} from "lucide-react";

export function GeistShowcasePage() {
  const addToast = useAppStore((s) => s.addToast);

  // State controls for interactive testing
  const [searchValue, setSearchValue] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [toggle1, setToggle1] = useState(false);
  const [toggle2, setToggle2] = useState(true);
  const [toggleSize, setToggleSize] = useState<"sm" | "md" | "lg">("md");
  const [segmentedVal, setSegmentedVal] = useState("preview");
  const [progressVal, setProgressVal] = useState(65);

  const sampleCode = `// Geist Design System Example
import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(c => c + 1)}>
      Clicked {count} times
    </button>
  );
}`;

  return (
    <div className="min-h-screen bg-[var(--ds-background-200)] text-[var(--ds-gray-1000)] p-8 max-w-[1100px] mx-auto space-y-12">
      {/* Header */}
      <div className="border-b border-[var(--ds-gray-400)] pb-6">
        <div className="flex items-center gap-3 mb-2">
          <Sparkles className="size-6 text-[var(--ds-blue-700)]" />
          <h1 className="text-3xl font-bold tracking-tight">Geist Design System</h1>
        </div>
        <p className="text-[var(--ds-gray-900)] text-base">
          Interactive showcase and test matrix for 11 core Vercel Geist components.
        </p>
      </div>

      {/* 1. TABS */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">1. Tabs</h2>
          <Badge variant="blue" size="sm">Primary & Secondary</Badge>
        </div>

        {/* Primary Tabs */}
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-4">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)]">
            Primary Tabs (Underline)
          </span>
          <Tabs defaultValue="overview" variant="primary">
            <TabsList>
              <TabsTrigger value="overview" icon={<Globe className="size-3.5" />}>
                Overview
              </TabsTrigger>
              <TabsTrigger value="deployments" icon={<Zap className="size-3.5" />}>
                Deployments
              </TabsTrigger>
              <TabsTrigger value="analytics">Analytics</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="p-3 text-sm text-[var(--ds-gray-900)]">
              Overview tab content rendering in elevated Geist surface.
            </TabsContent>
            <TabsContent value="deployments" className="p-3 text-sm text-[var(--ds-gray-900)]">
              Deployments status and serverless functions list.
            </TabsContent>
            <TabsContent value="analytics" className="p-3 text-sm text-[var(--ds-gray-900)]">
              Core Web Vitals analytics metrics.
            </TabsContent>
          </Tabs>

          <Separator />

          {/* Secondary Tabs */}
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)]">
            Secondary Tabs (Segmented Pills)
          </span>
          <Tabs defaultValue="apple" variant="secondary">
            <TabsList>
              <TabsTrigger value="apple">Apple</TabsTrigger>
              <TabsTrigger value="orange">Orange</TabsTrigger>
              <TabsTrigger value="mango">Mango</TabsTrigger>
            </TabsList>
            <TabsContent value="apple" className="text-sm text-[var(--ds-gray-900)]">
              Apple tab selected (Secondary pill highlight).
            </TabsContent>
            <TabsContent value="orange" className="text-sm text-[var(--ds-gray-900)]">
              Orange tab selected.
            </TabsContent>
            <TabsContent value="mango" className="text-sm text-[var(--ds-gray-900)]">
              Mango tab selected.
            </TabsContent>
          </Tabs>
        </div>
      </section>

      {/* 2. DOTS */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">2. Dots</h2>
          <Badge variant="success" size="sm">Loading, Status & Menu</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-6">
          {/* LoadingDots */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Loading Dots
            </span>
            <div className="flex items-center gap-8">
              <LoadingDots size="sm" label="Connecting" />
              <LoadingDots size="md" label="Loading" />
              <LoadingDots size="lg" label="Processing" />
              <LoadingDots size="md" />
            </div>
          </div>

          <Separator />

          {/* StatusDot */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Status Dot Variants
            </span>
            <div className="flex flex-wrap items-center gap-6">
              <StatusDot status="ready" label="Ready" pulse />
              <StatusDot status="success" label="Healthy" />
              <StatusDot status="building" label="Building" pulse />
              <StatusDot status="warning" label="Warning" />
              <StatusDot status="error" label="Error" pulse />
              <StatusDot status="queued" label="Queued" />
              <StatusDot status="neutral" label="Neutral" />
            </div>
          </div>

          <Separator />

          {/* DotsMenu */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Dots Menu Triggers
            </span>
            <div className="flex items-center gap-4">
              <DotsMenu orientation="vertical" size="sm" />
              <DotsMenu orientation="vertical" size="md" />
              <DotsMenu orientation="horizontal" size="sm" />
              <DotsMenu orientation="horizontal" size="md" />
            </div>
          </div>
        </div>
      </section>

      {/* 3. SEARCH INPUT */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">3. Search Input</h2>
          <Badge variant="purple" size="sm">3 Sizes & Suffixes</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-[var(--ds-gray-700)] block mb-1">
                Small (sm) with Shortcut
              </label>
              <SearchInput
                size="sm"
                placeholder="Search resources..."
                shortcut="⌘K"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onClear={() => setSearchValue("")}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--ds-gray-700)] block mb-1">
                Medium (md) with Loading Toggle
              </label>
              <SearchInput
                size="md"
                placeholder="Search repositories..."
                loading={searchLoading}
                shortcut="/"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-[var(--ds-gray-700)] block mb-1">
              Large (lg) Hero Search
            </label>
            <SearchInput
              size="lg"
              placeholder="Search across all docs, APIs, and components..."
              shortcut="⌘F"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSearchLoading((prev) => !prev)}
            >
              Toggle Loading State
            </Button>
            <span className="text-xs text-[var(--ds-gray-900)]">
              Input Value: "{searchValue}"
            </span>
          </div>
        </div>
      </section>

      {/* 4. PROGRESS */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">4. Progress</h2>
          <Badge variant="amber" size="sm">{progressVal}%</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-5">
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-[var(--ds-gray-900)]">
              <span>Default Progress (Medium, 8px)</span>
              <span>{progressVal}%</span>
            </div>
            <Progress value={progressVal} size="md" />
          </div>

          <div className="space-y-2">
            <span className="text-xs text-[var(--ds-gray-900)]">Success Variant (Small, 4px)</span>
            <Progress value={progressVal} variant="success" size="sm" />
          </div>

          <div className="space-y-2">
            <span className="text-xs text-[var(--ds-gray-900)]">Warning Variant (Extra Small, 2px)</span>
            <Progress value={progressVal} variant="warning" size="xs" />
          </div>

          <div className="space-y-2">
            <span className="text-xs text-[var(--ds-gray-900)]">Indeterminate Sliding Shimmer</span>
            <Progress indeterminate size="sm" variant="blue" />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProgressVal((p) => Math.max(0, p - 15))}
            >
              -15%
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProgressVal((p) => Math.min(100, p + 15))}
            >
              +15%
            </Button>
          </div>
        </div>
      </section>

      {/* 5. BADGE */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">5. Badge</h2>
          <Badge variant="default" size="sm">Tokens & Shapes</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-5">
          {/* Variants */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Geist Color Variants
            </span>
            <div className="flex flex-wrap gap-2.5">
              <Badge variant="default">Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
              <Badge variant="inverted">Inverted</Badge>
              <Badge variant="blue">Blue / Info</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="error">Error</Badge>
              <Badge variant="purple">Purple</Badge>
              <Badge variant="pink">Pink</Badge>
            </div>
          </div>

          <Separator />

          {/* Sizes and Icons */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Sizes, Shapes & Icons
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <Badge size="sm" icon={<Zap className="size-3" />}>
                Small (h-5)
              </Badge>
              <Badge size="md" icon={<Shield className="size-3.5" />}>
                Medium (h-6)
              </Badge>
              <Badge size="lg" icon={<CheckCircle className="size-4" />}>
                Large (h-7)
              </Badge>
              <Badge shape="square" variant="outline">
                Square Shape
              </Badge>
            </div>
          </div>
        </div>
      </section>

      {/* 6. BREADCRUMBS */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">6. Breadcrumbs</h2>
          <Badge variant="default" size="sm">Accessible Nav</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-4">
          <Breadcrumbs>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#home">Home</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink href="#projects">Projects</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbEllipsis />
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink href="#features">Settings</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Geist Design System</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumbs>
        </div>
      </section>

      {/* 7. CODE BLOCK & SNIPPET */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">7. Code Block & Snippet</h2>
          <Badge variant="blue" size="sm">Copy & Monospace</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-6">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-2">
              CodeBlock with Header & Line Numbers
            </span>
            <CodeBlock
              filename="Counter.tsx"
              language="tsx"
              code={sampleCode}
              showLineNumbers
              highlightedLines={[4, 5]}
            />
          </div>

          <Separator />

          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-2">
              Command Snippets
            </span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Snippet text="pnpm add @geist-ui/core" variant="default" />
              <Snippet text="git checkout -b feature/geist-ui" variant="inverted" />
            </div>
          </div>
        </div>
      </section>

      {/* 8. SEPARATOR */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">8. Separator</h2>
          <Badge variant="default" size="sm">Horizontal, Vertical & Label</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-4">
          <p className="text-sm text-[var(--ds-gray-900)]">Content above horizontal separator</p>
          <Separator />
          <p className="text-sm text-[var(--ds-gray-900)]">Content below horizontal separator</p>

          <Separator label="OR CONTINUE WITH" />

          <div className="flex items-center h-6 text-sm text-[var(--ds-gray-900)]">
            <span>Left side</span>
            <Separator orientation="vertical" className="mx-4" />
            <span>Middle</span>
            <Separator orientation="vertical" className="mx-4" />
            <span>Right side</span>
          </div>
        </div>
      </section>

      {/* 9. TOAST */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">9. Toast</h2>
          <Badge variant="success" size="sm">Floating Feedback</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-4">
          <p className="text-sm text-[var(--ds-gray-900)]">
            Click any button below to trigger live Geist toasts:
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                addToast({
                  type: "success",
                  message: "Deployment deployed to production in 1.4s.",
                })
              }
            >
              Success Toast
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                addToast({
                  type: "error",
                  message: "Build failed: syntax error in compiler output.",
                })
              }
            >
              Error Toast
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                addToast({
                  type: "info",
                  message: "Geist Design System theme migration synchronized.",
                })
              }
            >
              Info Toast
            </Button>
          </div>
        </div>
      </section>

      {/* 10. TOOLTIP */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">10. Tooltip</h2>
          <Badge variant="inverted" size="sm">Inverted Pill & Shortcut</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-4">
          <p className="text-sm text-[var(--ds-gray-900)]">
            Hover over the buttons below to view Geist tooltips with directional placement and kbd shortcuts:
          </p>
          <div className="flex flex-wrap gap-4">
            <SimpleTooltip content="Search anything across the app" shortcut="⌘K" side="top">
              <Button variant="outline" size="sm">Hover Me (Top + ⌘K)</Button>
            </SimpleTooltip>

            <SimpleTooltip content="Save current workspace" shortcut="⌘S" side="bottom">
              <Button variant="outline" size="sm">Hover Me (Bottom + ⌘S)</Button>
            </SimpleTooltip>

            <SimpleTooltip content="Inspect active environment variables" side="left">
              <Button variant="outline" size="sm">Hover Me (Left)</Button>
            </SimpleTooltip>

            <SimpleTooltip content="Close drawer panel" shortcut="ESC" side="right">
              <Button variant="outline" size="sm">Hover Me (Right + ESC)</Button>
            </SimpleTooltip>
          </div>
        </div>
      </section>

      {/* 11. TOGGLE & SWITCH */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">11. Toggle & Switch</h2>
          <Badge variant="blue" size="sm">Sliding & Segmented</Badge>
        </div>
        <div className="rounded-lg border border-[var(--ds-gray-400)] bg-[var(--ds-background-100)] p-6 space-y-6">
          {/* Toggle Switch */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Sliding Toggle Switch
            </span>
            <div className="flex flex-wrap items-center gap-8">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={toggle1}
                  onCheckedChange={setToggle1}
                  size={toggleSize}
                  aria-label="Toggle 1"
                />
                <span className="text-sm font-medium">
                  State: {toggle1 ? "Checked" : "Unchecked"}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <Toggle
                  checked={toggle2}
                  onCheckedChange={setToggle2}
                  size={toggleSize}
                  label="Word Wrap"
                  description="Wrap long lines"
                />
              </div>

              <div className="flex items-center gap-3">
                <Toggle checked={false} disabled size={toggleSize} label="Disabled" />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-4">
              <span className="text-xs text-[var(--ds-gray-700)]">Toggle Size:</span>
              {(["sm", "md", "lg"] as const).map((sz) => (
                <button
                  key={sz}
                  onClick={() => setToggleSize(sz)}
                  className={`px-2 py-0.5 text-xs rounded border ${
                    toggleSize === sz
                      ? "bg-[var(--ds-gray-1000)] text-[var(--ds-background-100)] border-transparent"
                      : "border-[var(--ds-gray-400)] text-[var(--ds-gray-900)]"
                  }`}
                >
                  {sz.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Segmented Switch */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--ds-gray-700)] block mb-3">
              Segmented Switch (Radio Pill)
            </span>
            <SegmentedSwitch
              value={segmentedVal}
              onValueChange={setSegmentedVal}
              options={[
                { value: "source", label: "Source Code", icon: <FileCode className="size-3.5" /> },
                { value: "preview", label: "Interactive Preview", icon: <Globe className="size-3.5" /> },
                { value: "schema", label: "JSON Schema", icon: <Folder className="size-3.5" /> },
              ]}
            />
            <p className="text-xs text-[var(--ds-gray-900)] mt-2">
              Selected: <strong>{segmentedVal}</strong>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
