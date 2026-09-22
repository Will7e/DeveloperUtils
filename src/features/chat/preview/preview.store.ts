// ============================================================
// Preview Store — Per-Conversation Build & Console State
// ============================================================
// Holds the preview runtime's output for the active conversation:
// build status/diagnostics, blob URLs, and the ring buffer of
// console output captured from the sandboxed iframe via the
// preview bridge. The agent's get_preview_feedback tool reads
// from here; the PreviewPane renders it.

import { create } from "zustand";

import { releaseLivePreview } from "./host/preview-host-client";

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

/**
 * Everything one build produced, for ONE conversation.
 *
 * The store used to be a single slot: switching chats called
 * `setConversation`, which WIPED the document, the diagnostics and the
 * console, so coming back meant running esbuild-wasm over the whole
 * workspace again — and the app you were inspecting lost its state. It also
 * meant a build that finished after you had switched wrote its document into
 * whichever thread was on screen, so the pane could show another chat's app.
 *
 * With a snapshot per conversation, a switch is a VIEW change: the frame is
 * remounted from a document that already exists, and a build that lands
 * while you are elsewhere is filed under the thread that asked for it.
 */
export interface PreviewBuildSnapshot {
  status: PreviewBuildStatus;
  html: string | null;
  url: string | null;
  entry: string | null;
  diagnostics: PreviewDiagnostic[];
  console: PreviewConsoleEntry[];
  consoleSeq: number;
  jsHash: string;
  css: string;
  delivery: PreviewDelivery;
  deliveryNotice: string | null;
  /** Completion time of that build, for the "is this still current?" gates */
  builtAt: number;
}

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
  /**
   * conversationId → what its last build produced.
   *
   * The cache is the whole point of the split: the fields above are the
   * ACTIVE VIEW, this is what a switch restores from. Without the owner tag
   * on `setBuild`, a background thread's build would also overwrite the view
   * of whatever the user is looking at.
   */
  builds: Record<string, PreviewBuildSnapshot>;

  /** Switches the view to another conversation, restoring its last build */
  setConversation: (id: string | null) => void;
  /**
   * Build status, for one conversation. A status that belongs to a thread
   * the user is not looking at is cached, never shown: otherwise a rebuild
   * in a background chat flips the visible badge to "Building".
   */
  setStatus: (status: PreviewBuildStatus, conversationId?: string) => void;
  setBuild: (payload: {
    /** The thread this build belongs to — required, see the ownership rule */
    conversationId: string;
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

/** The active-view fields a snapshot carries */
function snapshotOf(s: PreviewState): PreviewBuildSnapshot {
  return {
    status: s.status,
    html: s.html,
    url: s.url,
    entry: s.entry,
    diagnostics: s.diagnostics,
    console: s.console,
    consoleSeq: s.consoleSeq,
    jsHash: s.jsHash,
    css: s.css,
    delivery: s.delivery,
    deliveryNotice: s.deliveryNotice,
    builtAt: s.builtAt,
  };
}

/**
 * How many threads keep a built document resident.
 *
 * A snapshot holds the whole document (hundreds of KB, sometimes more), so an
 * unbounded map over a day of conversations is a memory leak with a slow fuse
 * — the same reason the module and repo caches are bounded. Six is more than
 * a person switches between at once, and the thread on screen is never
 * dropped, so a miss costs a rebuild and never a wrong answer.
 */
const BUILD_CACHE_MAX = 6;

/** Keeps the newest `BUILD_CACHE_MAX` snapshots, and always `keep` */
function pruneBuilds(
  builds: Record<string, PreviewBuildSnapshot>,
  keep: string | null
): Record<string, PreviewBuildSnapshot> {
  const ids = Object.keys(builds);
  if (ids.length <= BUILD_CACHE_MAX) return builds;
  // Oldest first, and never the thread on screen.
  const droppable = ids
    .filter((id) => id !== keep)
    .sort((a, b) => (builds[a]?.builtAt ?? 0) - (builds[b]?.builtAt ?? 0));
  const next = { ...builds };
  let size = ids.length;
  for (const id of droppable) {
    if (size <= BUILD_CACHE_MAX) break;
    delete next[id];
    size -= 1;
  }
  return next;
}

/**
 * Releases the published documents behind cached builds that were just
 * dropped.
 *
 * A cache eviction has to reach the source of truth it cached. Without this,
 * the host kept serving a document nothing in the app could reach any more: a
 * readable copy of the user's source, held past the lifetime of every pointer
 * to it. Keyed by conversation, so a drop here can only release its own.
 */
function releaseDroppedBuilds(
  before: Record<string, PreviewBuildSnapshot>,
  after: Record<string, PreviewBuildSnapshot>
): void {
  for (const id of Object.keys(before)) {
    if (!after[id]) releaseLivePreview({ key: id });
  }
}

/** The view for a conversation with no build yet */
const IDLE_SNAPSHOT: PreviewBuildSnapshot = {
  status: "idle",
  html: null,
  url: null,
  entry: null,
  diagnostics: [],
  console: [],
  consoleSeq: CONSOLE_SEED_SEQ,
  jsHash: "",
  css: "",
  delivery: "inline",
  deliveryNotice: null,
  builtAt: 0,
};

/** Applies a snapshot to the active-view fields */
function viewOf(snapshot: PreviewBuildSnapshot) {
  return {
    ...snapshot,
    diagnostics: snapshot.diagnostics,
    console: snapshot.console,
    // The frame has to be MOUNTED by the pane for this snapshot; nothing is
    // running yet, and the previous thread's frame is about to be replaced.
    runtimeReady: false,
    screenshot: null,
  };
}

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
  builds: {},

  setConversation: (id) =>
    set((s) => {
      // Stash what the thread being left produced, then restore the one being
      // entered. Both halves matter: a stash keeps a background thread's work
      // from being lost, and a restore is what makes switching back instant
      // instead of a full rebuild.
      const stashed = { ...s.builds };
      if (s.conversationId) stashed[s.conversationId] = snapshotOf(s);
      const builds = pruneBuilds(stashed, id);
      releaseDroppedBuilds(stashed, builds);
      const restored = id ? builds[id] : undefined;
      return {
        builds,
        conversationId: id,
        // A DIFFERENT conversation's document is a different document: the
        // frame is remounted from it, and `buildId` is what tells the pane
        // and the probe cache that this is a new one.
        buildId: s.buildId + 1,
        ...(restored ? viewOf(restored) : viewOf(IDLE_SNAPSHOT)),
      };
    }),

  setStatus: (status, conversationId) =>
    set((s) => {
      const owner = conversationId ?? s.conversationId;
      // Background thread: file it, do not show it.
      if (owner && owner !== s.conversationId) {
        const known = s.builds[owner] ?? IDLE_SNAPSHOT;
        return { builds: { ...s.builds, [owner]: { ...known, status } } };
      }
      return { status };
    }),

  setBuild: (payload) =>
    set((s) => {
      const { conversationId, html, url, entry, diagnostics, status, jsHash, css, delivery, deliveryNotice } =
        payload;
      const previous = s.builds[conversationId] ?? (conversationId === s.conversationId ? snapshotOf(s) : IDLE_SNAPSHOT);
      const snapshot: PreviewBuildSnapshot = {
        status,
        html,
        url,
        entry,
        diagnostics,
        console: previous.console,
        consoleSeq: previous.consoleSeq,
        jsHash: jsHash ?? previous.jsHash,
        css: css ?? previous.css,
        delivery: delivery ?? previous.delivery,
        // Always the CURRENT build's reason, never a stale one: the console
        // dedupes repeats, the tooltip must not.
        deliveryNotice: deliveryNotice ?? null,
        builtAt: Date.now(),
      };
      const pendingBuilds = { ...s.builds, [conversationId]: snapshot };
      const builds = pruneBuilds(pendingBuilds, s.conversationId);
      releaseDroppedBuilds(pendingBuilds, builds);
      // A build for a thread the user is not looking at is CACHED, not
      // rendered. Rendering it is how another chat's app appeared in the
      // pane while the user was reading this one.
      if (conversationId !== s.conversationId) return { builds };
      return { builds, ...viewOf(snapshot), buildId: s.buildId + 1 };
    }),

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
