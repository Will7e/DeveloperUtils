// ============================================================
// Settings Panel — Configuration & Security overlay
// ============================================================

import { useState, useEffect } from "react";
import {
  X,
  Settings,
  Sun,
  Moon,
  ChevronDown,
  ShieldCheck,
  Trash2,
  AlertTriangle,
  Code2,
  Sliders,
  HardDrive,
  RefreshCw,
  Columns,
  GitCompare,
  FileCode2,
  Layers,
  CheckCircle2,
  Check,
  Sparkles,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { useVaultStore } from "@/services/vault.service";
import { getLocalStorageUsage } from "@/services/encrypted-storage.service";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface SettingsDropdownProps<T extends string | number> {
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
  className?: string;
}

function SettingsDropdown<T extends string | number>({
  value,
  options,
  onChange,
  className = "w-[130px]",
}: SettingsDropdownProps<T>) {
  const selectedOption = options.find((o) => o.value === value) || options[0];

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button className={`settings-select flex items-center justify-between ${className}`}>
          <span className="truncate">{selectedOption?.label}</span>
          <ChevronDown className="h-3 w-3 opacity-50 ml-2 flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className}>
        {options.map((opt) => (
          <DropdownMenuItem
            key={String(opt.value)}
            onSelect={() => onChange(opt.value)}
            onClick={() => onChange(opt.value)}
            className="cursor-pointer text-xs"
          >
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

type SettingsTab = "editor" | "experience" | "security";
type CleanupTarget = "all" | "comparators" | "diff" | "formatters" | "files";

export function SettingsPanel() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const editorSettings = useAppStore((s) => s.editorSettings);
  const updateEditorSettings = useAppStore((s) => s.updateEditorSettings);

  const resetVault = useVaultStore((s) => s.resetVault);
  const [activeTab, setActiveTab] = useState<SettingsTab>("editor");
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [pendingCleanup, setPendingCleanup] = useState<CleanupTarget | null>(null);
  const [storageUsage, setStorageUsage] = useState(() => getLocalStorageUsage());
  const [isRefreshingStorage, setIsRefreshingStorage] = useState(false);

  const handleRefreshStorage = () => {
    setIsRefreshingStorage(true);
    setStorageUsage(getLocalStorageUsage());
    setTimeout(() => {
      setIsRefreshingStorage(false);
    }, 650);
  };

  const comparatorSessions = useAppStore((s) => s.comparatorSessions);
  const activeComparatorSessionId = useAppStore((s) => s.activeComparatorSessionId);
  const closeOtherComparatorSessions = useAppStore((s) => s.closeOtherComparatorSessions);

  const diffSessions = useAppStore((s) => s.diffSessions);
  const activeDiffSessionId = useAppStore((s) => s.activeDiffSessionId);
  const closeOtherDiffSessions = useAppStore((s) => s.closeOtherDiffSessions);

  const formatterFiles = useAppStore((s) => s.formatterFiles);
  const activeFormatterFileId = useAppStore((s) => s.activeFormatterFileId);
  const closeOtherFormatterFiles = useAppStore((s) => s.closeOtherFormatterFiles);

  const files = useAppStore((s) => s.files);
  const activeFileId = useAppStore((s) => s.activeFileId);
  const closeOtherFiles = useAppStore((s) => s.closeOtherFiles);

  const addToast = useAppStore((s) => s.addToast);

  // Inactive tab counts
  const inactiveComparators = Math.max(0, (comparatorSessions?.length || 0) - 1);
  const inactiveDiffs = Math.max(0, (diffSessions?.length || 0) - 1);
  const inactiveFormatters =
    Math.max(0, (formatterFiles?.json?.length || 0) - 1) +
    Math.max(0, (formatterFiles?.xml?.length || 0) - 1);
  const inactiveFiles = Math.max(0, (files?.length || 0) - 1);
  const totalInactive = inactiveComparators + inactiveDiffs + inactiveFormatters + inactiveFiles;

  const cleanupTargetsConfig: Record<
    CleanupTarget,
    {
      label: string;
      count: number;
      description: string;
    }
  > = {
    all: {
      label: "All Features",
      count: totalInactive,
      description: `This will close all ${totalInactive} inactive background tabs across Comparators, Diff Checker, Formatters, and Code Editor. Your currently open active tabs in each tool will remain untouched.`,
    },
    comparators: {
      label: "Comparators Suite",
      count: inactiveComparators,
      description: `This will close ${inactiveComparators} inactive comparator tab${inactiveComparators === 1 ? "" : "s"}. Your active comparator session will remain open.`,
    },
    diff: {
      label: "Diff Checker",
      count: inactiveDiffs,
      description: `This will close ${inactiveDiffs} inactive diff tab${inactiveDiffs === 1 ? "" : "s"}. Your active diff comparison session will remain open.`,
    },
    formatters: {
      label: "Formatters (JSON & XML)",
      count: inactiveFormatters,
      description: `This will close ${inactiveFormatters} inactive formatter file tab${inactiveFormatters === 1 ? "" : "s"}. Your active formatter document will remain open.`,
    },
    files: {
      label: "Code Editor Files",
      count: inactiveFiles,
      description: `This will close ${inactiveFiles} background file tab${inactiveFiles === 1 ? "" : "s"} in the code editor. Your currently open file will remain open.`,
    },
  };

  // Refresh storage meter when settings opens or active tab is security
  useEffect(() => {
    if (settingsOpen && activeTab === "security") {
      setStorageUsage(getLocalStorageUsage());
    }
  }, [settingsOpen, activeTab]);

  const handleExecuteCleanup = (target: CleanupTarget) => {
    let closedCount = 0;

    if (target === "all" || target === "comparators") {
      if (comparatorSessions && comparatorSessions.length > 1) {
        closedCount += comparatorSessions.length - 1;
        closeOtherComparatorSessions(activeComparatorSessionId);
      }
    }

    if (target === "all" || target === "diff") {
      if (diffSessions && diffSessions.length > 1) {
        closedCount += diffSessions.length - 1;
        closeOtherDiffSessions(activeDiffSessionId);
      }
    }

    if (target === "all" || target === "formatters") {
      if (formatterFiles?.json && formatterFiles.json.length > 1) {
        closedCount += formatterFiles.json.length - 1;
        closeOtherFormatterFiles("json", activeFormatterFileId.json);
      }
      if (formatterFiles?.xml && formatterFiles.xml.length > 1) {
        closedCount += formatterFiles.xml.length - 1;
        closeOtherFormatterFiles("xml", activeFormatterFileId.xml);
      }
    }

    if (target === "all" || target === "files") {
      if (files && files.length > 1) {
        const keepId = activeFileId || files[0]!.id;
        closedCount += files.length - 1;
        closeOtherFiles(keepId);
      }
    }

    setPendingCleanup(null);

    setTimeout(() => {
      setStorageUsage(getLocalStorageUsage());
      addToast({
        message:
          closedCount > 0
            ? `Cleaned up ${closedCount} inactive tab${closedCount === 1 ? "" : "s"} (${cleanupTargetsConfig[target].label})`
            : "No inactive tabs were found to close",
        type: "success",
      });
    }, 120);
  };

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        toggleSettings();
      }
    };
    if (settingsOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen, toggleSettings]);

  if (!settingsOpen) return null;

  return (
    <div className="settings-overlay" onClick={toggleSettings}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="settings-header">
          <div className="settings-header-info">
            <div className="settings-header-icon-box">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <div className="settings-header-title-text">Settings</div>
              <div className="settings-header-desc">
                Preferences, editor configuration, and local vault security
              </div>
            </div>
          </div>
          <ActionTooltip content="Close (Esc)" side="left">
            <button
              type="button"
              className="settings-close-btn"
              onClick={toggleSettings}
              aria-label="Close Settings"
            >
              <X className="w-4 h-4" />
            </button>
          </ActionTooltip>
        </div>

        {/* Category Tabs */}
        <div className="settings-tabs-bar">
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "editor" ? "active" : ""}`}
            onClick={() => setActiveTab("editor")}
          >
            <Code2 size={14} />
            <span>Editor</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "experience" ? "active" : ""}`}
            onClick={() => setActiveTab("experience")}
          >
            <Sliders size={14} />
            <span>Experience</span>
          </button>
          <button
            type="button"
            className={`settings-tab-item ${activeTab === "security" ? "active" : ""}`}
            onClick={() => setActiveTab("security")}
          >
            <ShieldCheck size={14} />
            <span>Security & Vault</span>
          </button>
        </div>

        {/* Body */}
        <div className="settings-body">
          {/* ── TAB: Editor ── */}
          {activeTab === "editor" && (
            <div className="settings-tab-content">
              {/* Section: Typography & Display */}
              <div className="settings-section">
                <div className="settings-section-title">Typography & Display</div>

                {/* Font Family */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Font Family</label>
                    <span className="settings-sublabel">Primary font family for all code editors</span>
                  </div>
                  <div className="settings-control">
                    <SettingsDropdown
                      value={editorSettings.fontFamily}
                      onChange={(v) => updateEditorSettings({ fontFamily: v })}
                      options={[
                        {
                          label: "Monospace",
                          value: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
                        },
                        { label: "System UI", value: "system-ui, sans-serif" },
                        { label: "Courier", value: "'Courier New', Courier, monospace" },
                      ]}
                      className="w-[130px]"
                    />
                  </div>
                </div>

                {/* Font Size */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Font Size</label>
                    <span className="settings-sublabel">Editor font rendering scale in pixels</span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="range"
                      min="10"
                      max="24"
                      value={editorSettings.fontSize}
                      onChange={(e) =>
                        updateEditorSettings({ fontSize: Number(e.target.value) })
                      }
                      className="settings-slider"
                    />
                    <span className="settings-value">{editorSettings.fontSize}px</span>
                  </div>
                </div>

                {/* Tab Size */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Tab Size</label>
                    <span className="settings-sublabel">Spaces inserted per indentation stop</span>
                  </div>
                  <div className="settings-control">
                    <SettingsDropdown
                      value={editorSettings.tabSize}
                      onChange={(v) => updateEditorSettings({ tabSize: Number(v) })}
                      options={[
                        { label: "2 spaces", value: 2 },
                        { label: "4 spaces", value: 4 },
                        { label: "8 spaces", value: 8 },
                      ]}
                      className="w-[110px]"
                    />
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              {/* Section: Editor Behavior */}
              <div className="settings-section">
                <div className="settings-section-title">Editor Behavior</div>

                {/* Word Wrap */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Word Wrap</label>
                    <span className="settings-sublabel">Soft-wrap lines exceeding editor width</span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${editorSettings.wordWrap === "on" ? "active" : ""}`}
                      onClick={() =>
                        updateEditorSettings({
                          wordWrap: editorSettings.wordWrap === "on" ? "off" : "on",
                        })
                      }
                    >
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                </div>

                {/* Minimap */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Minimap</label>
                    <span className="settings-sublabel">Display bird's-eye code overview scrollbar</span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${editorSettings.minimap ? "active" : ""}`}
                      onClick={() =>
                        updateEditorSettings({ minimap: !editorSettings.minimap })
                      }
                    >
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                </div>

                {/* Line Numbers */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Line Numbers</label>
                    <span className="settings-sublabel">Gutter numbering display format</span>
                  </div>
                  <div className="settings-control">
                    <SettingsDropdown
                      value={editorSettings.lineNumbers}
                      onChange={(v) =>
                        updateEditorSettings({ lineNumbers: v as "on" | "off" | "relative" })
                      }
                      options={[
                        { label: "On", value: "on" },
                        { label: "Off", value: "off" },
                        { label: "Relative", value: "relative" },
                      ]}
                      className="w-[110px]"
                    />
                  </div>
                </div>

                {/* Bracket Colorization */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Bracket Colors</label>
                    <span className="settings-sublabel">Colorize matching pairs of brackets and braces</span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${editorSettings.bracketPairColorization ? "active" : ""}`}
                      onClick={() =>
                        updateEditorSettings({
                          bracketPairColorization: !editorSettings.bracketPairColorization,
                        })
                      }
                    >
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB: Experience ── */}
          {activeTab === "experience" && (
            <div className="settings-tab-content">
              {/* Section: Theme & Appearance */}
              <div className="settings-section">
                <div className="settings-section-title">Theme & Appearance</div>

                {/* Theme */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">
                      <span className="flex items-center gap-1.5">
                        {editorSettings.theme === "dark" ? (
                          <Moon className="w-3.5 h-3.5 text-accent" />
                        ) : (
                          <Sun className="w-3.5 h-3.5 text-yellow-500" />
                        )}
                        Application Theme
                      </span>
                    </label>
                    <span className="settings-sublabel">Toggle between Obsidian Dark and Slate Light</span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${editorSettings.theme === "light" ? "active" : ""}`}
                      onClick={() =>
                        updateEditorSettings({
                          theme: editorSettings.theme === "dark" ? "light" : "dark",
                        })
                      }
                    >
                      <span className="toggle-thumb" />
                    </button>
                    <span className="settings-value capitalize">
                      {editorSettings.theme}
                    </span>
                  </div>
                </div>

                {/* Cursor Style */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Cursor Style</label>
                    <span className="settings-sublabel">Active editor caret rendering style</span>
                  </div>
                  <div className="settings-control">
                    <SettingsDropdown
                      value={editorSettings.cursorStyle}
                      onChange={(v) =>
                        updateEditorSettings({
                          cursorStyle: v as "line" | "block" | "underline",
                        })
                      }
                      options={[
                        { label: "Line", value: "line" },
                        { label: "Block", value: "block" },
                        { label: "Underline", value: "underline" },
                      ]}
                      className="w-[110px]"
                    />
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              {/* Section: Formatting */}
              <div className="settings-section">
                <div className="settings-section-title">Code Formatting</div>

                {/* Format on Paste */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Format on Paste</label>
                    <span className="settings-sublabel">Automatically format clipboard text upon paste</span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${editorSettings.formatOnPaste ? "active" : ""}`}
                      onClick={() =>
                        updateEditorSettings({
                          formatOnPaste: !editorSettings.formatOnPaste,
                        })
                      }
                    >
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                </div>

                {/* Format on Type */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Format on Type</label>
                    <span className="settings-sublabel">Auto-format line following trigger characters</span>
                  </div>
                  <div className="settings-control">
                    <button
                      type="button"
                      className={`settings-toggle ${editorSettings.formatOnType ? "active" : ""}`}
                      onClick={() =>
                        updateEditorSettings({
                          formatOnType: !editorSettings.formatOnType,
                        })
                      }
                    >
                      <span className="toggle-thumb" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              {/* Section: Execution Engine */}
              <div className="settings-section">
                <div className="settings-section-title">Execution Engine</div>

                {/* Execution Timeout */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Execution Timeout</label>
                    <span className="settings-sublabel">Maximum compiler / sandbox execution duration</span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="range"
                      min="5000"
                      max="60000"
                      step="5000"
                      value={editorSettings.executionTimeout}
                      onChange={(e) =>
                        updateEditorSettings({ executionTimeout: Number(e.target.value) })
                      }
                      className="settings-slider"
                    />
                    <span className="settings-value">
                      {editorSettings.executionTimeout / 1000}s
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB: Security & Vault ── */}
          {activeTab === "security" && (
            <div className="settings-tab-content">
              {/* Clean, reassuring security overview card */}
              <div className="settings-security-card">
                <div className="settings-security-badge-group">
                  <div className="settings-security-card-icon-wrap">
                    <ShieldCheck size={18} />
                  </div>
                  <div>
                    <div className="settings-security-card-title">Local Vault Security</div>
                    <div className="settings-security-card-desc">
                      Sensitive data including API tokens, custom headers, and environment variables are automatically encrypted and stored locally in your browser. Secrets never leave your machine.
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-divider" />

              {/* Storage Reset Action */}
              <div className="settings-section">
                <div className="settings-section-title">Data Management & Quota</div>

                {/* Storage Utilization Gauge */}
                <div className="settings-row flex-col items-start gap-2 py-3 border-b border-border-1">
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-4 w-4 text-accent" />
                      <span className="settings-label">Local Storage Utilization</span>
                    </div>
                    <span className="text-xs font-mono font-medium text-text-1">
                      {storageUsage.usedFormatted} / {storageUsage.quotaFormatted} ({storageUsage.percentage}%)
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full h-2 rounded-full bg-bg-2 overflow-hidden border border-border-1">
                    <div
                      className={`h-full transition-all duration-300 ${
                        storageUsage.percentage >= 85
                          ? "bg-red"
                          : storageUsage.percentage >= 70
                          ? "bg-amber"
                          : "bg-accent"
                      }`}
                      style={{ width: `${Math.max(4, storageUsage.percentage)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between w-full text-[11px] text-text-3">
                    <span>
                      {storageUsage.percentage >= 85
                        ? "⚠️ Storage nearly full! Close inactive tabs to prevent save failures."
                        : "Encrypted at rest with AES-256-GCM. 100% client-side."}
                    </span>
                    <button
                      type="button"
                      className="text-accent hover:underline flex items-center gap-1 cursor-pointer transition-opacity disabled:opacity-60"
                      onClick={handleRefreshStorage}
                      disabled={isRefreshingStorage}
                    >
                      <RefreshCw
                        className={cn(
                          "h-3 w-3",
                          isRefreshingStorage && "refresh-spin-anim"
                        )}
                      />
                      <span>{isRefreshingStorage ? "Refreshed" : "Refresh"}</span>
                    </button>
                  </div>
                </div>

                {/* Clean Inactive Sessions Dropdown */}
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="flex items-center gap-2">
                      <label className="settings-label">Clean Inactive Tabs</label>
                      {totalInactive > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium">
                          {totalInactive} idle
                        </span>
                      )}
                    </div>
                    <span className="settings-sublabel">
                      Close background tabs across features to free browser storage
                    </span>
                  </div>

                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="settings-action-btn flex items-center gap-1.5"
                      >
                        <span>Clean Up Tabs</span>
                        <ChevronDown className="h-3 w-3 opacity-70" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[230px] p-1.5">
                      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-3">
                        Select tool to clean
                      </div>

                      <DropdownMenuItem
                        onSelect={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("all");
                        }}
                        onClick={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("all");
                        }}
                        disabled={totalInactive === 0}
                        className="flex items-center justify-between cursor-pointer py-1.5 text-xs font-medium"
                      >
                        <div className="flex items-center gap-2">
                          <Layers className="h-3.5 w-3.5 text-accent" />
                          <span>All Features</span>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-text-2 font-mono">
                          {totalInactive}
                        </span>
                      </DropdownMenuItem>

                      <DropdownMenuSeparator />

                      <DropdownMenuItem
                        onSelect={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("comparators");
                        }}
                        onClick={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("comparators");
                        }}
                        disabled={inactiveComparators === 0}
                        className="flex items-center justify-between cursor-pointer py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Columns className="h-3.5 w-3.5 text-text-2" />
                          <span>Comparators Suite</span>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-text-2 font-mono">
                          {inactiveComparators}
                        </span>
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        onSelect={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("diff");
                        }}
                        onClick={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("diff");
                        }}
                        disabled={inactiveDiffs === 0}
                        className="flex items-center justify-between cursor-pointer py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <GitCompare className="h-3.5 w-3.5 text-text-2" />
                          <span>Diff Checker</span>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-text-2 font-mono">
                          {inactiveDiffs}
                        </span>
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        onSelect={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("formatters");
                        }}
                        onClick={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("formatters");
                        }}
                        disabled={inactiveFormatters === 0}
                        className="flex items-center justify-between cursor-pointer py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <FileCode2 className="h-3.5 w-3.5 text-text-2" />
                          <span>Formatters</span>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-text-2 font-mono">
                          {inactiveFormatters}
                        </span>
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        onSelect={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("files");
                        }}
                        onClick={() => {
                          setShowResetConfirm(false);
                          setPendingCleanup("files");
                        }}
                        disabled={inactiveFiles === 0}
                        className="flex items-center justify-between cursor-pointer py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <Code2 className="h-3.5 w-3.5 text-text-2" />
                          <span>Code Editor</span>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-2 border border-border-1 text-text-2 font-mono">
                          {inactiveFiles}
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Cleanup Confirmation Subform */}
                {pendingCleanup && (
                  <div className="settings-vault-subform">
                    <div className="settings-subform-title text-accent">
                      <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                      <span>Confirm Clean Up: {cleanupTargetsConfig[pendingCleanup].label}</span>
                    </div>
                    <p className="settings-subform-warning">
                      {cleanupTargetsConfig[pendingCleanup].description}
                    </p>
                    <div className="settings-subform-btns">
                      <button
                        type="button"
                        onClick={() => handleExecuteCleanup(pendingCleanup)}
                        className="settings-subform-action-btn flex items-center justify-center gap-1.5"
                      >
                        <CheckCircle2 size={12} />
                        <span>
                          Confirm & Close {cleanupTargetsConfig[pendingCleanup].count} Tab
                          {cleanupTargetsConfig[pendingCleanup].count === 1 ? "" : "s"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingCleanup(null)}
                        className="settings-subform-cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="settings-row">
                  <div className="settings-row-info">
                    <label className="settings-label">Clear Stored Credentials</label>
                    <span className="settings-sublabel">
                      Wipe saved API tokens, custom headers, and environment secrets
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn danger"
                    onClick={() => {
                      setShowResetConfirm(true);
                      setPendingCleanup(null);
                    }}
                  >
                    <Trash2 size={12} />
                    Clear Data
                  </button>
                </div>
              </div>

              {/* Reset Confirmation Subform */}
              {showResetConfirm && (
                <div className="settings-vault-subform danger-box">
                  <div className="settings-subform-title danger">
                    <AlertTriangle size={14} />
                    Confirm Data Reset
                  </div>
                  <p className="settings-subform-warning">
                    This will delete all saved API tokens, custom headers, and environment variables stored in your browser. A fresh local encryption session will be started automatically.
                  </p>
                  <div className="settings-subform-btns">
                    <button
                      type="button"
                      onClick={() => {
                        resetVault();
                        setShowResetConfirm(false);
                        toggleSettings();
                      }}
                      className="settings-subform-danger-btn"
                    >
                      Yes, Clear Stored Data
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowResetConfirm(false)}
                      className="settings-subform-cancel"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="settings-footer">
          <span className="settings-footer-hint">
            ⌘, or Esc to close • ⌘K for Command Palette
          </span>
        </div>
      </div>
    </div>
  );
}
