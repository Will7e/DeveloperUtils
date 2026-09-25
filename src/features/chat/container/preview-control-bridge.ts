// ============================================================
// Preview Control Bridge — The Host Half Of The Control Channel
// ============================================================
// Phase 5's runtime experiment, packaged as a module with a testable core:
// the bootstrap (preview-control.ts) is injected into the preview's
// index.html at mount time, and this module carries requests to it and
// matches the replies.
//
// The open runtime question — does the preview's postMessage reach this
// document through the WebContainer forwarding path — is exactly what the
// spike must validate in a real browser; every other part of the channel is
// implemented and unit-tested here against fake ports. The failure modes
// are honest either way: no iframe, no reply, or a timeout all return a
// precise error the tool result states, never a hang and never a guess.
// ============================================================

import {
  PREVIEW_CONTROL_PROTOCOL_VERSION,
  PREVIEW_CONTROL_REQUEST,
  PREVIEW_CONTROL_RESPONSE,
  injectBootstrap,
  looksLikeHtmlDocument,
  type SerializedSnapshot,
} from "./preview-control";

/** How long one control op may take before the request is abandoned */
export const PREVIEW_CONTROL_TIMEOUT_MS = 6_000;

/** The iframe element that hosts the preview (WorkspacePreview renders it) */
const PREVIEW_FRAME_SELECTOR = "iframe.chat-preview-frame";

interface PendingRequest {
  resolve: (value: ControlOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ControlOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; status?: "no-frame" | "timeout" | "refused" };

const pending = new Map<string, PendingRequest>();
let seq = 0;
let listening = false;

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    handleControlReply(event.data);
  });
}

/**
 * The listener body, exported for tests: a node test has no `window` to
 * dispatch a MessageEvent on, and the pairing logic is the thing under test.
 * Production reaches this only through the listener above.
 */
export function handleControlReply(data: unknown): void {
  const message = data as { channel?: string; id?: string; result?: Record<string, unknown> } | null;
  if (!message || message.channel !== PREVIEW_CONTROL_RESPONSE || typeof message.id !== "string") return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  waiter.resolve(
    message.result && message.result.ok === true
      ? { ok: true, result: message.result }
      : {
          ok: false,
          error: String(message.result?.error ?? "the preview refused the operation"),
          status: "refused",
        }
  );
}

/** The preview iframe's content window, or null when no preview is shown */
export function previewFrameWindow(): Window | null {
  if (typeof document === "undefined") return null;
  const frame = document.querySelector(PREVIEW_FRAME_SELECTOR) as HTMLIFrameElement | null;
  return frame?.contentWindow ?? null;
}

/** Test seam: replace the frame lookup (jsdom-less tests inject a fake) */
let frameWindowOverride: Window | null | undefined = undefined;

export function setPreviewFrameWindowForTest(window: Window | null): void {
  frameWindowOverride = window;
}

function frameWindow(): Window | null {
  return frameWindowOverride !== undefined ? frameWindowOverride : previewFrameWindow();
}

/**
 * Sends one control op to the bootstrap and waits for the matching reply.
 *
 * Every failure is a returned error, never a throw and never a hang: the
 * timeout is the boundary between "the app did not answer" and "the app is
 * broken", and the wording keeps them apart.
 */
export function sendPreviewControl(op: string, args: Record<string, unknown> = {}): Promise<ControlOutcome> {
  ensureListener();
  const target = frameWindow();
  if (!target) {
    return Promise.resolve({
      ok: false,
      status: "no-frame",
      error:
        "No preview is open in this tab, so there is nothing to control. Start the preview from the workspace strip, then snapshot again.",
    });
  }
  const id = `c${(seq += 1)}`;
  return new Promise<ControlOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        ok: false,
        status: "timeout",
        error:
          `The preview did not answer the \`${op}\` request within ${Math.round(PREVIEW_CONTROL_TIMEOUT_MS / 1000)}s. ` +
          `Either the app is wedged, or this build does not carry the control bootstrap (a runtime capability, not a code problem).`,
      });
    }, PREVIEW_CONTROL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      target.postMessage({ channel: PREVIEW_CONTROL_REQUEST, id, op, ...args }, "*");
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `The control message could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/** The serialized snapshot from a successful get-tree, typed */
export function snapshotFrom(outcome: ControlOutcome): SerializedSnapshot | null {
  if (!outcome.ok) return null;
  const snapshot = outcome.result.snapshot as SerializedSnapshot | undefined;
  return snapshot ?? null;
}

/**
 * Injects the control bootstrap into the mount plan's index.html, in place.
 *
 * Called once per startPreview, before the tree reaches the container: the
 * served page then carries the listener from its first byte. A project with
 * no index.html-shaped document (an API server, a static file the dev
 * server generates) is left alone — there is nothing to inject into, and
 * inventing an entry file is how a preview gets broken.
 *
 * Returns whether the plan was changed, so the caller can note it.
 */
export function injectPreviewControl(plan: {
  tree: Record<string, unknown>;
  files: { path: string; bytes: number }[];
}): { injected: boolean; note: string | null } {
  const index = findIndexHtml(plan.tree);
  if (!index) return { injected: false, note: null };
  const entry = index.node as { file: { contents: string } };
  if (typeof entry.file?.contents !== "string") return { injected: false, note: null };
  if (!looksLikeHtmlDocument(entry.file.contents)) return { injected: false, note: null };
  const before = entry.file.contents;
  entry.file.contents = injectBootstrap(before);
  if (entry.file.contents === before) return { injected: false, note: null };
  // The plan's own bookkeeping must agree with its tree: `files` carries the
  // byte counts the mount reports, and `bytes` is their sum — leaving either
  // stale makes `describeMount` publish a size nobody can reproduce.
  plan.files = plan.files.map((f) =>
    f.path === index.path ? { ...f, bytes: entry.file.contents.length } : f
  );
  const total = plan.files.reduce((sum, f) => sum + f.bytes, 0);
  (plan as unknown as { bytes: number }).bytes = total;
  return {
    injected: true,
    note: "The preview's page carries this app's control bootstrap, so the agent can read and drive the rendered UI.",
  };
}

/** Depth-first search for an index.html the container will actually serve */
function findIndexHtml(
  tree: Record<string, unknown>,
  prefix = ""
): { path: string; node: unknown } | null {
  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if ("file" in (node as Record<string, unknown>)) {
      if (name === "index.html") return { path, node };
      continue;
    }
    if ("directory" in (node as Record<string, unknown>)) {
      const found = findIndexHtml(
        (node as { directory: Record<string, unknown> }).directory,
        path
      );
      if (found) return found;
    }
  }
  return null;
}

/** Version of the protocol this host speaks (kept beside the constant) */
export function previewControlVersion(): number {
  return PREVIEW_CONTROL_PROTOCOL_VERSION;
}

/** Test seam: forget pending requests and the listener */
export function resetPreviewControl(): void {
  for (const [, waiter] of pending) clearTimeout(waiter.timer);
  pending.clear();
  seq = 0;
  listening = false;
  frameWindowOverride = undefined;
}
