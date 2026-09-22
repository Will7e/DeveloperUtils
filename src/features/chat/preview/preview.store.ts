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

/**
 * How a build reached the frame.
 *
 * `hosted` means a preview host served it from its own origin, so storage,
 * cookies, Web Locks and — the one that matters most — the app's ROUTER all
 * work. `inline` is the fallback: a sandboxed `srcdoc` document, isolated but
 * capability-starved and unable to match a single route (its URL path is
 * literally "srcdoc"). Which one you are looking at is the difference
 * between a working preview and a black frame, so the pane says it out loud.
 */
export type PreviewDelivery = "hosted" | "inline";

export interface PreviewState {
  conversationId: string | null;
  status: PreviewBuildStatus;
  /**
   * The built entry document itself, rendered into the frame with `srcdoc`.
   *
   * The frame used to navigate to a blob: URL. A blob document has to be
   * NAVIGATED to before any of it runs, and navigation to blob: URLs is
   * refused outright in some browser builds — the frame then fires no load
   * event at all and the pane is simply black, with nothing to diagnose.
   * `srcdoc` is parsed into the frame directly, so the document always
   * arrives, and it keeps the sandbox/opaque-origin contract unchanged.
   */
  html: string | null;
  /** Blob URL of the built document — kept for the "open in new tab" link */
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
  /**
   * Fingerprint of the emitted JS. The pane compares it with what the
   * running frame was built from: same JS means a CSS-only change, which is
   * injected into the live document instead of remounting it.
   */
  jsHash: string;
  /** The bundle's CSS, kept for that hot swap */
  css: string;
  /** The delivery path the current build took */
  delivery: PreviewDelivery;
  /** One sentence explaining that path, for the pane's tooltip */
  deliveryNotice: string | null;

  setConversation: (id: string | null) => void;
  setStatus: (status: PreviewBuildStatus) => void;
  setBuild: (payload: {
    html: string | null;
    url: string | null;
    entry: string | null;
    diagnostics: PreviewDiagnostic[];
    status: PreviewBuildStatus;
    jsHash?: string;
    css?: string;
    delivery?: PreviewDelivery;
    deliveryNotice?: string | null;
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
  html: null,
  url: null,
  entry: null,
  diagnostics: [],
  console: [],
  consoleSeq: CONSOLE_SEED_SEQ,
  runtimeReady: false,
  screenshot: null,
  buildId: 0,
  builtAt: 0,
  jsHash: "",
  css: "",
  delivery: "inline",
  deliveryNotice: null,

  setConversation: (id) =>
    set({
      conversationId: id,
      status: "idle",
      html: null,
      url: null,
      entry: null,
      diagnostics: [],
      console: [],
      runtimeReady: false,
      screenshot: null,
      jsHash: "",
      css: "",
      delivery: "inline",
      deliveryNotice: null,
    }),

  setStatus: (status) => set({ status }),

  setBuild: ({ html, url, entry, diagnostics, status, jsHash, css, delivery, deliveryNotice }) =>
    set((s) => ({
      html,
      url,
      entry,
      diagnostics,
      status,
      runtimeReady: false,
      screenshot: null,
      jsHash: jsHash ?? s.jsHash,
      css: css ?? s.css,
      delivery: delivery ?? s.delivery,
      // Always the CURRENT build's reason, never a stale one: the console
      // dedupes repeats, the tooltip must not.
      deliveryNotice: deliveryNotice ?? null,
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

/**
 * Whether the agent panel (changes / preview) belongs on screen now.
 *
 * The rule is derived, never toggled: attaching a repository opens the
 * panel (an attached repo means the agent can start editing, and the
 * changes it makes are the point), and closing it stashes the `attachedAt`
 * timestamp the close applied to so it stays closed for THAT attachment —
 * a fresh attach, or the floating button clearing the stamp, brings it
 * back.
 *
 * Pure and separated from the component for one reason: this exact
 * expression was wrong once (an extra manual-open flag ANDed in meant the
 * panel could never open on its own), and nothing could catch it.
 */
export function isAgentPanelVisible(params: {
  repoAttached: boolean;
  attachedAt: number;
  closedForAttachment: number | null;
}): boolean {
  return params.repoAttached && params.closedForAttachment !== params.attachedAt;
}
