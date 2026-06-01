// ============================================================
// DiffChecker — Monaco-powered text/code diff viewer
// ============================================================

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { Monaco } from "@monaco-editor/react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { DndContext, closestCenter, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { SortableTab } from "@/components/ui/SortableTab";
import {
  ArrowLeftRight,
  Trash2,
  Copy,
  Check,
  Download,
  Settings2,
  ChevronDown,
  Plus,
  X,
  Columns,
  Rows,
  FileCode2,
  Minus,
  Equal,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  SimpleTooltip,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app.store";
import type { editor } from "monaco-editor";

// Monaco-supported languages for the language selector
const DIFF_LANGUAGES = [
  { id: "plaintext", label: "Plain Text" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "json", label: "JSON" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "xml", label: "XML" },
  { id: "python", label: "Python" },
  { id: "java", label: "Java" },
  { id: "csharp", label: "C#" },
  { id: "sql", label: "SQL" },
  { id: "yaml", label: "YAML" },
  { id: "markdown", label: "Markdown" },
  { id: "shell", label: "Shell" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "php", label: "PHP" },
  { id: "ruby", label: "Ruby" },
  { id: "swift", label: "Swift" },
  { id: "kotlin", label: "Kotlin" },
];

interface ActionTooltipProps {
  children: React.ReactNode;
  content: string;
  side?: "top" | "bottom" | "left" | "right";
}

const ActionTooltip = ({ children, content, side = "top" }: ActionTooltipProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      {children}
    </TooltipTrigger>
    <TooltipContent side={side}>
      <p>{content}</p>
    </TooltipContent>
  </Tooltip>
);

interface DiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

function computeDiffStats(original: string, modified: string): DiffStats {
  if (!original && !modified) {
    return { additions: 0, deletions: 0, unchanged: 0 };
  }

  const origLines = original ? original.split("\n") : [];
  const modLines = modified ? modified.split("\n") : [];

  // Simple line-level diff stats using multiset intersection
  const origCounts = new Map<string, number>();
  origLines.forEach((line) => {
    origCounts.set(line, (origCounts.get(line) || 0) + 1);
  });

  let matched = 0;
  const remaining = new Map<string, number>(origCounts);
  modLines.forEach((line) => {
    const count = remaining.get(line);
    if (count && count > 0) {
      matched++;
      remaining.set(line, count - 1);
    }
  });

  return {
    additions: modLines.length - matched,
    deletions: origLines.length - matched,
    unchanged: matched,
  };
}
// ============================================================
// Smart Language Detection — weighted scoring across 20 languages
// ============================================================

interface LangRule {
  /** Monaco language id */
  lang: string;
  /** Patterns to test — each match adds `weight` to the score */
  patterns: RegExp[];
  /** Score per match */
  weight: number;
}

const LANG_RULES: LangRule[] = [
  // ---- JSON ----
  { lang: "json", weight: 20, patterns: [/^\s*[\[{]/] },
  { lang: "json", weight: 15, patterns: [/"[^"]+"\s*:/] },
  // ---- HTML ----
  { lang: "html", weight: 20, patterns: [/<!DOCTYPE\s+html/i] },
  { lang: "html", weight: 12, patterns: [/<html[\s>]/i, /<head[\s>]/i, /<body[\s>]/i, /<div[\s>]/i, /<span[\s>]/i, /<script[\s>]/i, /<link[\s>]/i, /<meta[\s>]/i] },
  // ---- XML (non-HTML) ----
  { lang: "xml", weight: 20, patterns: [/<\?xml\s/i] },
  { lang: "xml", weight: 10, patterns: [/<\/[a-zA-Z][a-zA-Z0-9_.:.-]*>/, /<[a-zA-Z][a-zA-Z0-9_.:.-]*\s+[a-zA-Z]+=["']/] },
  { lang: "xml", weight: 10, patterns: [/<[a-zA-Z][a-zA-Z0-9_.:.-]*\s*\/>/] },
  { lang: "xml", weight: 12, patterns: [/<[a-zA-Z]+:[a-zA-Z]+[\s>]/] },
  { lang: "xml", weight: 8, patterns: [/<!\[CDATA\[/, /<!--[\s\S]*?-->/, /<!DOCTYPE\s+(?!html)[a-zA-Z]/i, /xmlns[:=]/i] },
  // ---- CSS ----
  { lang: "css", weight: 12, patterns: [/[.#@][a-zA-Z][\w-]*\s*\{/, /:\s*(flex|grid|block|none|absolute|relative|inherit)\s*;/, /@media\s/, /@import\s/, /@keyframes\s/, /background-color\s*:/, /font-size\s*:/, /margin\s*:/, /padding\s*:/] },
  // ---- TypeScript (check before JavaScript — TS is a superset) ----
  { lang: "typescript", weight: 15, patterns: [/:\s*(string|number|boolean|void|any|never|unknown)\b/, /interface\s+[A-Z]/, /type\s+[A-Z]\w*\s*=/, /<[A-Z]\w*>/, /as\s+(string|number|any|unknown)\b/, /import\s+type\s/, /export\s+type\s/] },
  // ---- JavaScript ----
  { lang: "javascript", weight: 8, patterns: [/\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /\bvar\s+\w+\s*=/, /=>\s*[{(]/, /function\s+\w+\s*\(/, /\brequire\s*\(/, /\bmodule\.exports\b/, /\bconsole\.(log|error|warn)\s*\(/, /import\s+.*\s+from\s+['"]/, /export\s+(default\s+)?/] },
  // ---- Python ----
  { lang: "python", weight: 12, patterns: [/\bdef\s+\w+\s*\(/, /\bclass\s+\w+\s*[:(]/, /\bimport\s+\w+/, /\bfrom\s+\w+\s+import\b/, /\bprint\s*\(/, /\bself\.\w+/, /\belif\s+/, /\bexcept\s+/, /#!.*python/i, /^\s*@\w+/m] },
  // ---- Java ----
  { lang: "java", weight: 12, patterns: [/\bpublic\s+(static\s+)?class\s/, /\bpublic\s+static\s+void\s+main\s*\(/, /System\.out\.print/, /\bpackage\s+[\w.]+;/, /\bimport\s+java\./, /\bprivate\s+(final\s+)?[\w<>[\]]+\s+\w+/, /\bnew\s+\w+\s*\(/, /@Override\b/] },
  // ---- C# ----
  { lang: "csharp", weight: 12, patterns: [/\bnamespace\s+[\w.]+/, /\busing\s+System/, /\bConsole\.(Write|ReadLine)/, /\bpublic\s+(async\s+)?Task\b/, /\bvar\s+\w+\s*=\s*new\b/, /\bstring\[\]/, /\bList</, /\basync\s+Task\b/] },
  // ---- SQL ----
  { lang: "sql", weight: 14, patterns: [/\bSELECT\s+.+\s+FROM\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i, /\bALTER\s+TABLE\b/i, /\bDROP\s+TABLE\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bWHERE\s+\w+\s*(=|<|>|IN|LIKE)\b/i, /\bJOIN\s+\w+\s+ON\b/i, /\bGROUP\s+BY\b/i, /\bORDER\s+BY\b/i] },
  // ---- YAML ----
  { lang: "yaml", weight: 10, patterns: [/^[\w-]+:\s+\S/m, /^[\w-]+:\s*$/m, /^\s+-\s+\w/m, /^---\s*$/m] },
  // ---- Markdown ----
  { lang: "markdown", weight: 8, patterns: [/^#{1,6}\s+\w/m, /^\*\*\w.*\*\*$/m, /\[.*\]\(https?:\/\//m, /^```\w*$/m, /^>\s+\w/m, /^-{3,}\s*$/m, /^\|.*\|.*\|$/m] },
  // ---- Shell / Bash ----
  { lang: "shell", weight: 12, patterns: [/^#!/m, /\becho\s+/, /\bsudo\s+/, /\bchmod\s+/, /\bapt(-get)?\s+install\b/, /\bbrew\s+install\b/, /\bnpm\s+(install|run|start)\b/, /\bgit\s+(commit|push|pull|clone)\b/, /\bexport\s+\w+=/, /\$\{\w+\}/, /\|\s*(grep|awk|sed|sort|head|tail)\b/] },
  // ---- Go ----
  { lang: "go", weight: 14, patterns: [/\bpackage\s+main\b/, /\bfunc\s+\w+\s*\(/, /\bfmt\.(Print|Sprintf|Errorf)/, /\bimport\s*\(/, /:=\s*/, /\bgo\s+func\b/, /\bdefer\s+/, /\bchan\s+/, /\bstruct\s*\{/] },
  // ---- Rust ----
  { lang: "rust", weight: 14, patterns: [/\bfn\s+\w+\s*\(/, /\blet\s+mut\s+/, /\bimpl\s+\w+/, /\bpub\s+fn\b/, /\buse\s+std::/, /\bprintln!\s*\(/, /\bmatch\s+\w+/, /\b->\s*(Self|bool|i32|u32|String|Result)\b/, /\bOption</, /\bResult</] },
  // ---- PHP ----
  { lang: "php", weight: 16, patterns: [/<\?php\b/, /\$\w+\s*=/, /\becho\s+['"]/, /\bfunction\s+\w+\s*\(.*\$/, /\bclass\s+\w+\s*(extends|implements)\b/, /\b(public|private|protected)\s+function\b/, /->\w+\s*\(/] },
  // ---- Ruby ----
  { lang: "ruby", weight: 12, patterns: [/\bdef\s+\w+/, /\bend\s*$/, /\bputs\s+/, /\brequire\s+['"]/, /\bclass\s+\w+\s*<\s*\w+/, /\battr_(accessor|reader|writer)\b/, /\bdo\s*\|/, /\b\w+\.each\b/] },
  // ---- Swift ----
  { lang: "swift", weight: 12, patterns: [/\bfunc\s+\w+\s*\(/, /\bvar\s+\w+:\s*\w+/, /\blet\s+\w+:\s*\w+/, /\bimport\s+(Foundation|UIKit|SwiftUI)\b/, /\bguard\s+let\b/, /\bprint\s*\(/, /\bstruct\s+\w+\s*:\s*\w+/, /\bprotocol\s+\w+/] },
  // ---- Kotlin ----
  { lang: "kotlin", weight: 12, patterns: [/\bfun\s+\w+\s*\(/, /\bval\s+\w+\s*[:=]/, /\bvar\s+\w+\s*[:=]/, /\bprintln\s*\(/, /\bdata\s+class\b/, /\bcompanion\s+object\b/, /\bwhen\s*\(/, /\bimport\s+kotlin\./] },
];

/**
 * Detect the most likely Monaco language id from content.
 * Returns null if confidence is too low to make a call.
 */
function detectLanguage(content: string): string | null {
  if (!content || content.trim().length < 10) return null;

  // Fast-path: try JSON parse
  const trimmed = content.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch { /* not valid json, continue scoring */ }
  }

  // Score each language
  const scores = new Map<string, number>();
  for (const rule of LANG_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(content)) {
        scores.set(rule.lang, (scores.get(rule.lang) || 0) + rule.weight);
      }
    }
  }

  if (scores.size === 0) return null;

  // Find the winner
  let bestLang = "plaintext";
  let bestScore = 0;
  for (const [lang, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  // TypeScript subsumes JavaScript — if both score high, prefer the one with more evidence
  if (bestLang === "javascript" && (scores.get("typescript") || 0) >= bestScore) {
    bestLang = "typescript";
  }

  // XML-vs-HTML disambiguation: if HTML won but the content has no actual HTML-specific
  // tags, it's probably XML (both share angle-bracket syntax).
  if (bestLang === "html" && (scores.get("xml") || 0) > 0) {
    const htmlSpecificTags = /<(html|head|body|div|span|p|a|ul|ol|li|table|form|input|button|script|link|meta|style|section|header|footer|nav|main|article|aside|h[1-6])[\s>]/i;
    if (!htmlSpecificTags.test(content)) {
      bestLang = "xml";
      bestScore = scores.get("xml") || bestScore;
    }
  }

  // Require a minimum threshold to avoid false positives
  if (bestScore < 10) return null;

  return bestLang;
}

export function DiffChecker() {
  // Store state
  const sessions = useAppStore((s) => s.diffSessions);
  const activeSessionId = useAppStore((s) => s.activeDiffSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveDiffSession);
  const createSession = useAppStore((s) => s.createDiffSession);
  const deleteSession = useAppStore((s) => s.deleteDiffSession);
  const renameSession = useAppStore((s) => s.renameDiffSession);
  const updateSessionInput = useAppStore((s) => s.updateDiffSessionInput);
  const updateSessionLanguage = useAppStore((s) => s.updateDiffSessionLanguage);
  const reorderSessions = useAppStore((s) => s.reorderDiffSessions);
  const diffSettings = useAppStore((s) => s.diffSettings);
  const updateDiffSettings = useAppStore((s) => s.updateDiffSettings);
  const addToast = useAppStore((s) => s.addToast);
  const currentThemeSetting = useAppStore((s) => s.editorSettings.theme);

  // Local state — we track original/modified content locally for immediate
  // reactivity. Store is used for persistence only (synced on every change).
  const [localOriginal, setLocalOriginal] = useState("");
  const [localModified, setLocalModified] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);

  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const originalEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modifiedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Track last content used for detection — allows re-detection when content changes significantly
  const lastDetectedContentRef = useRef<string>("");

  // DnD sensor
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sessions.findIndex((s) => s.id === active.id);
    const newIndex = sessions.findIndex((s) => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderSessions(oldIndex, newIndex);
    }
  }, [sessions, reorderSessions]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0]!;

  // Hydration — load persisted content into local state on mount and session switch
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    setLocalOriginal(activeSession.original);
    setLocalModified(activeSession.modified);
    // Reset detection tracking on session switch
    lastDetectedContentRef.current = "";
  }, [activeSession.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resize observer for diff editor layout
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      if (diffEditorRef.current) {
        diffEditorRef.current.layout();
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Sync the Monaco model language when activeSession.language changes
  // (covers both auto-detection and manual language selector changes)
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;
    const origModel = originalEditorRef.current?.getModel();
    const modModel = modifiedEditorRef.current?.getModel();
    if (origModel) m.editor.setModelLanguage(origModel, activeSession.language);
    if (modModel) m.editor.setModelLanguage(modModel, activeSession.language);
  }, [activeSession.language]);

  // ================================================================
  // Content sync + auto-detection — polling-based (guaranteed to work)
  // Reads directly from Monaco editor refs every 300ms.
  // Handles: stats bar updates, store persistence, language detection.
  // Re-detects whenever content changes significantly from last detection.
  // ================================================================
  useEffect(() => {
    if (!isHydrated) return;

    const interval = setInterval(() => {
      const origEditor = originalEditorRef.current;
      const modEditor = modifiedEditorRef.current;
      if (!origEditor || !modEditor) return;

      let origValue: string;
      let modValue: string;
      try {
        origValue = origEditor.getValue();
        modValue = modEditor.getValue();
      } catch {
        return;
      }

      // Sync original to local state + store (only if changed)
      setLocalOriginal((prev) => {
        if (prev !== origValue) {
          const s = useAppStore.getState();
          s.updateDiffSessionInput(s.activeDiffSessionId, "original", origValue);
          return origValue;
        }
        return prev;
      });

      // Sync modified to local state + store (only if changed)
      setLocalModified((prev) => {
        if (prev !== modValue) {
          const s = useAppStore.getState();
          s.updateDiffSessionInput(s.activeDiffSessionId, "modified", modValue);
          return modValue;
        }
        return prev;
      });

      // --- Continuous language detection ---
      // Pick whichever side has substantial content (prefer original)
      const content = origValue.trim().length >= 10
        ? origValue
        : modValue.trim().length >= 10
          ? modValue
          : null;

      if (!content) {
        // Both sides empty — reset detection and language to plaintext
        if (lastDetectedContentRef.current !== "") {
          lastDetectedContentRef.current = "";
          const state = useAppStore.getState();
          state.updateDiffSessionLanguage(state.activeDiffSessionId, "plaintext");
        }
        return;
      }

      // Check if content has changed enough to warrant re-detection.
      // Compare by length ratio — if content changed by >30%, re-detect.
      const lastLen = lastDetectedContentRef.current.length;
      const curLen = content.length;
      const lenRatio = lastLen > 0 ? Math.abs(curLen - lastLen) / Math.max(lastLen, 1) : 1;
      const contentChanged = lastDetectedContentRef.current !== content && lenRatio > 0.3;

      if (lastDetectedContentRef.current === "" || contentChanged) {
        lastDetectedContentRef.current = content;
        const detected = detectLanguage(content);
        const state = useAppStore.getState();
        const sessionId = state.activeDiffSessionId;
        const currentLang = state.diffSessions.find(s => s.id === sessionId)?.language;
        const newLang = detected ?? "plaintext";

        // Only update if language actually changed
        if (newLang !== currentLang) {
          state.updateDiffSessionLanguage(sessionId, newLang);
          const label = DIFF_LANGUAGES.find((l) => l.id === newLang)?.label ?? newLang;
          state.addToast({ message: `Detected: ${label}`, type: "info" });
        }
      }
    }, 300);

    return () => clearInterval(interval);
  }, [isHydrated]);

  const handleDiffEditorMount: DiffOnMount = useCallback((diffEditor, monaco) => {
    diffEditorRef.current = diffEditor;

    // Define custom theme matching the code editor
    monaco.editor.defineTheme("devutils-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "5c6378", fontStyle: "italic" },
        { token: "keyword", foreground: "c084fc" },
        { token: "string", foreground: "22c55e" },
        { token: "number", foreground: "eab308" },
        { token: "type", foreground: "3b82f6" },
        { token: "function", foreground: "a5b4fc" },
        { token: "variable", foreground: "e8eaed" },
        { token: "operator", foreground: "9aa0b4" },
        { token: "regexp", foreground: "f97316" },
      ],
      colors: {
        "editor.background": "#0c0e14",
        "editor.foreground": "#e8eaed",
        "editor.lineHighlightBackground": "#ffffff05",
        "editor.selectionBackground": "#0ea5e935",
        "editor.inactiveSelectionBackground": "#0ea5e915",
        "editorCursor.foreground": "#0ea5e9",
        "editorLineNumber.foreground": "#2a2f42",
        "editorLineNumber.activeForeground": "#0ea5e9",
        "editor.selectionHighlightBackground": "#0ea5e910",
        "editorIndentGuide.background": "#1a1e2e",
        "editorIndentGuide.activeBackground": "#ffffff20",
        "editorBracketMatch.background": "#0ea5e925",
        "editorBracketMatch.border": "#0ea5e940",
        "editorWidget.background": "#12141d",
        "editorWidget.border": "#1e2235",
        "minimap.background": "#0c0e14",
        "scrollbarSlider.background": "#ffffff08",
        "scrollbarSlider.hoverBackground": "#ffffff14",
        "scrollbarSlider.activeBackground": "#ffffff20",
        // Diff highlight colors — visible but not overpowering
        "diffEditor.insertedTextBackground": "#22c55e30",
        "diffEditor.removedTextBackground": "#ef444430",
        "diffEditor.insertedLineBackground": "#22c55e15",
        "diffEditor.removedLineBackground": "#ef444415",
      },
    });

    // Light theme
    monaco.editor.defineTheme("devutils-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "94a3b8", fontStyle: "italic" },
        { token: "keyword", foreground: "7c3aed" },
        { token: "string", foreground: "059669" },
        { token: "number", foreground: "d97706" },
        { token: "type", foreground: "2563eb" },
        { token: "function", foreground: "4f46e5" },
        { token: "variable", foreground: "1e293b" },
        { token: "operator", foreground: "64748b" },
        { token: "regexp", foreground: "ea580c" },
      ],
      colors: {
        "editor.background": "#f8fafc",
        "editor.foreground": "#1e293b",
        "editor.lineHighlightBackground": "#0000000a",
        "editor.selectionBackground": "#0284c730",
        "editor.inactiveSelectionBackground": "#0284c715",
        "editorCursor.foreground": "#0284c7",
        "editorLineNumber.foreground": "#cbd5e1",
        "editorLineNumber.activeForeground": "#0284c7",
        "editor.selectionHighlightBackground": "#0284c712",
        "editorIndentGuide.background": "#e2e8f0",
        "editorIndentGuide.activeBackground": "#94a3b8",
        "editorBracketMatch.background": "#0284c720",
        "editorBracketMatch.border": "#0284c740",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#e2e8f0",
        "minimap.background": "#f8fafc",
        "scrollbarSlider.background": "#0000000a",
        "scrollbarSlider.hoverBackground": "#00000014",
        "scrollbarSlider.activeBackground": "#00000020",
        // Diff highlight colors for light mode
        "diffEditor.insertedTextBackground": "#05966930",
        "diffEditor.removedTextBackground": "#dc262630",
        "diffEditor.insertedLineBackground": "#05966912",
        "diffEditor.removedLineBackground": "#dc262612",
      },
    });

    const initTheme = useAppStore.getState().editorSettings.theme;
    monaco.editor.setTheme(initTheme === "light" ? "devutils-light" : "devutils-dark");

    // Store monaco instance so useEffect can call setModelLanguage later
    monacoRef.current = monaco;

    // Get sub-editors and store refs (polling reads from these)
    const origEditor = diffEditor.getOriginalEditor();
    const modEditor = diffEditor.getModifiedEditor();
    originalEditorRef.current = origEditor;
    modifiedEditorRef.current = modEditor;
  }, []);

  // Switch Monaco theme dynamically
  useEffect(() => {
    const m = monacoRef.current;
    if (m) {
      m.editor.setTheme(currentThemeSetting === "light" ? "devutils-light" : "devutils-dark");
    }
  }, [currentThemeSetting]);

  // ---- Helpers: always read live from the editor refs ----

  const getOriginalContent = useCallback((): string => {
    return originalEditorRef.current?.getValue() ?? localOriginal;
  }, [localOriginal]);

  const getModifiedContent = useCallback((): string => {
    return modifiedEditorRef.current?.getValue() ?? localModified;
  }, [localModified]);

  // Compute diff stats from LOCAL state (updated immediately by listeners)
  const stats = useMemo(
    () => computeDiffStats(localOriginal, localModified),
    [localOriginal, localModified]
  );

  const handleSwap = useCallback(() => {
    const orig = getOriginalContent();
    const mod = getModifiedContent();
    // Update store
    updateSessionInput(activeSession.id, "original", mod);
    updateSessionInput(activeSession.id, "modified", orig);
    // Update local state
    setLocalOriginal(mod);
    setLocalModified(orig);
    // Push into Monaco editors directly
    originalEditorRef.current?.setValue(mod);
    modifiedEditorRef.current?.setValue(orig);
    addToast({ message: "Swapped original ↔ modified", type: "info" });
  }, [activeSession.id, getOriginalContent, getModifiedContent, updateSessionInput, addToast]);

  const handleCopy = useCallback((id: string) => {
    const content = id === "orig-copy" ? getOriginalContent() : getModifiedContent();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    addToast({ message: "Copied to clipboard", type: "success" });
  }, [getOriginalContent, getModifiedContent, addToast]);

  const handleExportDiff = useCallback(() => {
    const orig = getOriginalContent();
    const mod = getModifiedContent();
    const origLines = orig.split("\n");
    const modLines = mod.split("\n");

    const lines: string[] = [];
    lines.push(`--- Original`);
    lines.push(`+++ Modified`);
    lines.push(`@@ Diff Export @@`);

    const maxLen = Math.max(origLines.length, modLines.length);
    for (let i = 0; i < maxLen; i++) {
      const origLine = origLines[i];
      const modLine = modLines[i];
      if (origLine === modLine) {
        lines.push(` ${origLine ?? ""}`);
      } else {
        if (origLine !== undefined) lines.push(`-${origLine}`);
        if (modLine !== undefined) lines.push(`+${modLine}`);
      }
    }

    const content = lines.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diff_${activeSession.name.replace(/\s+/g, "_")}.diff`;
    a.click();
    URL.revokeObjectURL(url);
    addToast({ message: "Diff exported", type: "success" });
  }, [activeSession.name, getOriginalContent, getModifiedContent, addToast]);

  const handleClear = useCallback(() => {
    // Update store
    updateSessionInput(activeSession.id, "original", "");
    updateSessionInput(activeSession.id, "modified", "");
    updateSessionLanguage(activeSession.id, "plaintext");
    // Update local state
    setLocalOriginal("");
    setLocalModified("");
    // Push into Monaco editors directly
    originalEditorRef.current?.setValue("");
    modifiedEditorRef.current?.setValue("");
    // Reset detection tracking
    lastDetectedContentRef.current = "";
    addToast({ message: "Both sides cleared", type: "info" });
  }, [activeSession.id, updateSessionInput, updateSessionLanguage, addToast]);

  if (!isHydrated) return null;

  const currentLang = DIFF_LANGUAGES.find((l) => l.id === activeSession.language) || DIFF_LANGUAGES[0]!;

  return (
    <div className="diff-checker-container">
      {/* Tab bar */}
      <div className="tabs-bar">
        <div className="tabs-list">
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sessions.map(s => s.id)} strategy={horizontalListSortingStrategy}>
              {sessions.map(session => (
                <SortableTab key={session.id} id={session.id}>
                  <button
                    className={cn(
                      "tab",
                      activeSessionId === session.id && "tab-active"
                    )}
                    onClick={() => setActiveSession(session.id)}
                    onDoubleClick={() => {
                      setEditName(session.name);
                      setEditingSessionId(session.id);
                    }}
                  >
                    <span className="tab-icon tab-icon-diff">
                      <FileCode2 className="h-3 w-3" />
                    </span>
                    {editingSessionId === session.id ? (
                      <input
                        autoFocus
                        className="tab-rename-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={() => {
                          if (editName.trim() && editName !== session.name) {
                            renameSession(session.id, editName.trim());
                          }
                          setEditingSessionId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.blur();
                          } else if (e.key === "Escape") {
                            setEditingSessionId(null);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="tab-name">
                        {session.name}
                      </span>
                    )}
                    <SimpleTooltip content="Close Tab">
                      <span
                        className="tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSession(session.id);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </SimpleTooltip>
                  </button>
                </SortableTab>
              ))}
            </SortableContext>
          </DndContext>
          <SimpleTooltip content="New Diff Session">
            <button
              className="tab-new"
              onClick={() => createSession()}
            >
              <Plus className="h-4 w-4" />
            </button>
          </SimpleTooltip>
        </div>

        <div className="tabs-toolbar">
          {/* Language selector */}
          <DropdownMenu open={langDropdownOpen} onOpenChange={setLangDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button className="toolbar-btn">
                <FileCode2 className="h-3.5 w-3.5" />
                {currentLang.label}
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="diff-lang-dropdown">
              <DropdownMenuLabel>Syntax Language</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {DIFF_LANGUAGES.map((lang) => (
                <DropdownMenuCheckboxItem
                  key={lang.id}
                  checked={activeSession.language === lang.id}
                  onCheckedChange={() => {
                    updateSessionLanguage(activeSession.id, lang.id);
                    setLangDropdownOpen(false);
                  }}
                  onSelect={(e) => e.preventDefault()}
                >
                  {lang.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tabs-toolbar-sep" />

          {/* View toggle */}
          <ActionTooltip content={diffSettings.renderSideBySide ? "Switch to inline view" : "Switch to side-by-side view"}>
            <button
              className="toolbar-btn"
              onClick={() => updateDiffSettings({ renderSideBySide: !diffSettings.renderSideBySide })}
            >
              {diffSettings.renderSideBySide ? (
                <Rows className="h-3.5 w-3.5" />
              ) : (
                <Columns className="h-3.5 w-3.5" />
              )}
              {diffSettings.renderSideBySide ? "Inline" : "Side by Side"}
            </button>
          </ActionTooltip>

          <div className="tabs-toolbar-sep" />

          {/* Settings */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="toolbar-btn">
                <Settings2 className="h-3.5 w-3.5" />
                Settings
                <ChevronDown className="h-3 w-3 opacity-50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Diff Options</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={diffSettings.renderSideBySide}
                onCheckedChange={(checked) => updateDiffSettings({ renderSideBySide: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Side by Side View
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={diffSettings.ignoreTrimWhitespace}
                onCheckedChange={(checked) => updateDiffSettings({ ignoreTrimWhitespace: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Ignore Whitespace
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={diffSettings.enableSplitViewResizing}
                onCheckedChange={(checked) => updateDiffSettings({ enableSplitViewResizing: checked })}
                onSelect={(e) => e.preventDefault()}
              >
                Resizable Split
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="tabs-toolbar-sep" />

          {/* Swap */}
          <ActionTooltip content="Swap original ↔ modified">
            <button className="toolbar-btn" onClick={handleSwap}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              Swap
            </button>
          </ActionTooltip>

          {/* Copy */}
          <ActionTooltip content="Copy modified text">
            <button className="toolbar-btn" onClick={() => handleCopy("mod-copy")}>
              {copied === "mod-copy" ? <Check className="h-3.5 w-3.5 text-green" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </ActionTooltip>

          {/* Export */}
          <ActionTooltip content="Export diff as .diff file">
            <button className="toolbar-btn" onClick={handleExportDiff}>
              <Download className="h-3.5 w-3.5" />
            </button>
          </ActionTooltip>

          <div className="tabs-toolbar-sep" />

          {/* Clear */}
          <ActionTooltip content="Clear both sides">
            <button className="toolbar-btn text-red hover:bg-red-dim" onClick={handleClear}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </ActionTooltip>
        </div>
      </div>

      {/* Diff stats bar */}
      <div className="diff-stats-bar">
        <div className="diff-stat diff-stat-add">
          <Plus className="h-3 w-3" />
          <span>{stats.additions} addition{stats.additions !== 1 ? "s" : ""}</span>
        </div>
        <div className="diff-stat diff-stat-del">
          <Minus className="h-3 w-3" />
          <span>{stats.deletions} deletion{stats.deletions !== 1 ? "s" : ""}</span>
        </div>
        <div className="diff-stat diff-stat-eq">
          <Equal className="h-3 w-3" />
          <span>{stats.unchanged} unchanged</span>
        </div>
        <div className="diff-stat-spacer" />
        <div className="diff-stat diff-stat-lang">
          {currentLang.label}
        </div>
      </div>

      {/* Monaco Diff Editor — key forces full remount per session so listeners are fresh */}
      <div className="diff-editor-container" ref={containerRef}>
        <DiffEditor
          key={activeSession.id}
          height="100%"
          language={activeSession.language}
          original={activeSession.original}
          modified={activeSession.modified}
          onMount={handleDiffEditorMount}
          theme={currentThemeSetting === "light" ? "devutils-light" : "devutils-dark"}
          options={{
            renderSideBySide: diffSettings.renderSideBySide,
            ignoreTrimWhitespace: diffSettings.ignoreTrimWhitespace,
            enableSplitViewResizing: diffSettings.enableSplitViewResizing,
            originalEditable: true,
            readOnly: false,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            minimap: { enabled: false },
            lineNumbers: "on",
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            renderLineHighlight: "all",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 12, bottom: 12 },
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
            diffWordWrap: "off",
            renderOverviewRuler: true,
          }}
          loading={
            <div className="flex-1 flex items-center justify-center bg-editor h-full">
              <div className="flex items-center gap-3">
                <div className="loading-spinner" />
                <span className="text-muted-foreground text-sm">
                  Loading diff editor...
                </span>
              </div>
            </div>
          }
        />
      </div>
    </div>
  );
}
