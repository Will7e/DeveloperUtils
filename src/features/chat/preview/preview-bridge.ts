// ============================================================
// Preview Bridge — Parent-Side Listener for the Iframe Runtime
// ============================================================
// Receives console/error events postMessaged by the bridge script
// embedded in every preview document (see preview-runtime.ts) and
// funnels them into the preview store. Mounted once in ChatPage.
//
// Bidirectional request/response (agent execution tools): the
// parent posts {source, reqId, kind, ...} requests INTO the iframe
// (run_js / query_dom); the sandboxed bridge script evaluates them
// and posts {source, reqId, ok, result|error} back. Pending
// requests are tracked with timeouts and failed when the preview
// reloads (buildId bump) — results must describe the CURRENT build.

import React from "react";
import { usePreviewStore } from "./preview.store";
import type { PreviewConsoleEntry } from "./preview.store";

const BRIDGE_SOURCE = "intab-preview";
const KNOWN_LEVELS: PreviewConsoleEntry["level"][] = ["log", "info", "warn", "error", "system"];

/** Hard deadline for one iframe round trip */
const REQUEST_TIMEOUT_MS = 5_000;

/** Pending iframe requests awaiting a response */
interface PendingRequest {
  resolve: (value: { ok: boolean; result?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 1;

/** Posts one request into the live preview iframe and awaits its response */
function postPreviewRequest(
  kind: "run_js" | "query_dom" | "layout" | "screenshot",
  payload: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const state = usePreviewStore.getState();
    const frame = document.querySelector<HTMLIFrameElement>("iframe.chat-preview-frame");
    if (!frame || !state.runtimeReady || !state.url) {
      resolve({ ok: false, error: "The preview is not running. Write files first and wait for the build to finish." });
      return;
    }
    const reqId = nextRequestId++;
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      resolve({ ok: false, error: "Preview request timed out (the app may be hung or reloading)." });
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(reqId, { resolve, timer });
    try {
      // "*" is required, not sloppy: the preview document is a blob URL in a
      // sandboxed frame, so its origin is opaque and cannot be named as a
      // targetOrigin. The receiving side checks sender identity instead.
      frame.contentWindow?.postMessage({ source: BRIDGE_SOURCE, reqId, kind, ...payload }, "*");
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(reqId);
      resolve({ ok: false, error: err instanceof Error ? err.message : "Could not reach the preview frame." });
    }
  });
}

/** Runs JS inside the preview page; resolves with the serialized result */
export function runJsInPreview(code: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return postPreviewRequest("run_js", { code });
}

/** Queries the preview's DOM; resolves with match count + snippets */
export function queryPreviewDom(selector: string, mode: "html" | "text"): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return postPreviewRequest("query_dom", { selector, mode });
}

/**
 * Reads a geometry map of the running preview: viewport/document size and
 * a capped list of viewport-relative boxes, collected INSIDE the preview
 * document (where layout actually happened) and analysed here.
 */
export function capturePreviewLayout(
  selector: string | undefined,
  maxElements: number | undefined
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return postPreviewRequest("layout", { selector, maxElements });
}

/**
 * Rasterizes the running preview inside its own frame and resolves with a
 * PNG data URL (plus its size). The capture has to happen there — the
 * preview's origin is opaque, so the parent cannot read its DOM — and it
 * is a DOM rasterization, not a screenshot of a real window: layout is
 * accurate, web fonts and remote images may be missing.
 */
export function capturePreviewScreenshot(
  selector?: string
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return postPreviewRequest("screenshot", { selector });
}

/** Rejects every pending request (preview reloaded / conversation switched) */
function failAllPending(reason: string): void {
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, error: reason });
  }
  pendingRequests.clear();
}

export function usePreviewBridge(): void {
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        source?: string;
        level?: string;
        text?: string;
        reqId?: number;
        ok?: boolean;
        result?: unknown;
        error?: string;
      } | null;
      if (!data || data.source !== BRIDGE_SOURCE) return;

      // Only the live preview iframe may speak on this channel. Without this
      // check any window holding a handle to the app could inject console
      // output (which is fed back to the model as observed reality) or answer
      // a pending run_js/query_dom request. The preview has an opaque origin
      // (`allow-scripts` without `allow-same-origin`), so identity — not
      // origin — is the checkable property here.
      const frame = document.querySelector<HTMLIFrameElement>("iframe.chat-preview-frame");
      if (!frame || event.source !== frame.contentWindow) return;

      // Response to a pending execution request
      if (typeof data.reqId === "number") {
        const pending = pendingRequests.get(data.reqId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(data.reqId);
          pending.resolve({ ok: data.ok === true, result: data.result, error: data.error });
        }
        return;
      }

      const level = KNOWN_LEVELS.includes(data.level as PreviewConsoleEntry["level"])
        ? (data.level as PreviewConsoleEntry["level"])
        : "log";
      if (level === "system" && data.text === "preview-ready") {
        usePreviewStore.getState().setRuntimeReady(true);
        return;
      }
      usePreviewStore.getState().addConsole([{ level, text: data.text ?? "" }]);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      failAllPending("Preview closed.");
    };
  }, []);

  // A reload (new build) invalidates in-flight requests: results
  // must describe the current build, not the one being torn down.
  React.useEffect(() => {
    const unsub = usePreviewStore.subscribe((state, prev) => {
      if (state.buildId !== prev.buildId) {
        failAllPending("The preview was rebuilt while the request was in flight — retry against the new build.");
      }
    });
    return unsub;
  }, []);
}

/** Forces the iframe to reload the current build */
export function refreshPreview(): void {
  usePreviewStore.setState((s) => ({ buildId: s.buildId + 1 }));
}
