// ============================================================
// Preview Store — Per-Conversation Build & Console State
// ============================================================
// Holds the preview runtime's output for the active conversation:
// build status/diagnostics, blob URLs, and the ring buffer of
// console output captured from the sandboxed iframe via the
// preview bridge. The agent's get_preview_feedback tool reads
// from here; the PreviewPane renders it.

import { create } from "zustand";

export type PreviewBuildStatus = "idle" | "unsupported" | "building" | "ready" | "error";

export interface PreviewDiagnostic {
  file?: string;
  line?: number;
  message: string;
  severity: "error" | "warning";
}

export interface PreviewConsoleEntry {
  id: number;
  level: "log" | "info" | "warn" | "error" | "system";
  text: string;
  at: number;
}

export interface PreviewState {
  conversationId: string | null;
  status: PreviewBuildStatus;
  /** Blob URL of the built entry document (iframe src) */
  url: string | null;
  /** Entry file the bundler resolved, shown in the header */
  entry: string | null;
  diagnostics: PreviewDiagnostic[];
  console: PreviewConsoleEntry[];
  /** Monotonic console id + unseen-error count (badge reset support) */
  consoleSeq: number;
  /** Set by the PreviewPane when the iframe reports ready */
  runtimeReady: boolean;
  /** Screenshot data URL captured on demand (transient) */
  screenshot: string | null;
  /** Bumped whenever a new build lands — iframe reload trigger */
  buildId: number;
  /** Completion time of the last successful/failed build (freshness gate) */
  builtAt: number;

  setConversation: (id: string | null) => void;
  setStatus: (status: PreviewBuildStatus) => void;
  setBuild: (payload: {
    url: string | null;
    entry: string | null;
    diagnostics: PreviewDiagnostic[];
    status: PreviewBuildStatus;
  }) => void;
  addConsole: (entries: Array<{ level: PreviewConsoleEntry["level"]; text: string }>) => void;
  clearConsole: () => void;
  markSeen: () => void;
  setRuntimeReady: (ready: boolean) => void;
  setScreenshot: (dataUrl: string | null) => void;
}

const CONSOLE_MAX = 200;
const CONSOLE_SEED_SEQ = 1;

export const usePreviewStore = create<PreviewState>((set) => ({
  conversationId: null,
  status: "idle",
  url: null,
  entry: null,
  diagnostics: [],
  console: [],
  consoleSeq: CONSOLE_SEED_SEQ,
  runtimeReady: false,
  screenshot: null,
  buildId: 0,
  builtAt: 0,

  setConversation: (id) =>
    set({
      conversationId: id,
      status: "idle",
      url: null,
      entry: null,
      diagnostics: [],
      console: [],
      runtimeReady: false,
      screenshot: null,
    }),

  setStatus: (status) => set({ status }),

  setBuild: ({ url, entry, diagnostics, status }) =>
    set((s) => ({
      url,
      entry,
      diagnostics,
      status,
      runtimeReady: false,
      screenshot: null,
      buildId: s.buildId + 1,
      builtAt: Date.now(),
    })),

  addConsole: (incoming) =>
    set((s) => {
      let seq = s.consoleSeq;
      const mapped = incoming.map((e) => ({
        id: seq++,
        level: e.level,
        text: e.text,
        at: Date.now(),
      }));
      const next = [...s.console, ...mapped];
      const overflow = Math.max(0, next.length - CONSOLE_MAX);
      const trimmed = overflow > 0 ? next.slice(overflow) : next;
      return { console: trimmed, consoleSeq: seq };
    }),

  clearConsole: () => set({ console: [] }),

  markSeen: () => set({ console: [] }),

  setRuntimeReady: (ready) => set({ runtimeReady: ready }),

  setScreenshot: (dataUrl) => set({ screenshot: dataUrl }),
}));

/** Snapshot of unseen errors for the agent feedback tool */
export function collectFeedbackErrors(): PreviewConsoleEntry[] {
  const state = usePreviewStore.getState();
  return state.console.filter((e) => e.level === "error" || e.level === "warn");
}
