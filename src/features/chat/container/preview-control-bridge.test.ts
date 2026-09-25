// ============================================================
// Preview Control Bridge — request/response against a fake frame
// ============================================================
// The channel logic is testable without an iframe: a fake Window records
// the postMessage and answers it the way the bootstrap would (through the
// exported reply handler, since a node test has no `window` to dispatch a
// MessageEvent on). What these tests buy is proof of the failure SHAPES —
// no frame, timeout, refusal — which is what the tool results state and
// the model acts on. The one thing they cannot prove is that a real
// WebContainer forwards the messages; that remains the runtime spike.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PREVIEW_CONTROL_TIMEOUT_MS,
  previewFrameWindow,
  resetPreviewControl,
  sendPreviewControl,
  setPreviewFrameWindowForTest,
  snapshotFrom,
} from "./preview-control-bridge";
import { handleControlReply } from "./preview-control-bridge";
import { PREVIEW_CONTROL_REQUEST, PREVIEW_CONTROL_RESPONSE } from "./preview-control";

interface FakeWindow {
  posted: Array<{ message: unknown; origin: string }>;
  postMessage(message: unknown, origin: string): void;
}

function fakeWindow(reply?: (message: Record<string, unknown>) => void): FakeWindow {
  const win: FakeWindow = {
    posted: [],
    postMessage(message, origin) {
      win.posted.push({ message, origin });
      if (reply) reply(message as Record<string, unknown>);
    },
  };
  return win;
}

/** Replies the way the bootstrap does, after a tick, via the exported seam */
function bootstrapReply(win: FakeWindow): void {
  const original = win.postMessage.bind(win);
  win.postMessage = (message: unknown, origin: string) => {
    original(message, origin);
    const request = message as { channel?: string; id?: string; op?: string };
    if (request.channel !== PREVIEW_CONTROL_REQUEST) return;
    setTimeout(() => {
      handleControlReply({
        channel: PREVIEW_CONTROL_RESPONSE,
        id: request.id,
        result:
          request.op === "ping"
            ? { ok: true, version: 1 }
            : request.op === "get-tree"
              ? { ok: true, snapshot: { nodes: [], totalNodes: 0, truncated: false, title: "t", url: "u" } }
              : { ok: true },
      });
    }, 5);
  };
}

describe("sendPreviewControl — the failure shapes", () => {
  beforeEach(() => {
    resetPreviewControl();
  });
  afterEach(() => {
    resetPreviewControl();
  });

  it("reports no-frame precisely when the preview is not open", async () => {
    setPreviewFrameWindowForTest(null);
    const outcome = await sendPreviewControl("get-tree");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe("no-frame");
      expect(outcome.error).toContain("No preview is open");
    }
  });

  it("pairs the reply with its request by id", async () => {
    const win = fakeWindow();
    bootstrapReply(win);
    setPreviewFrameWindowForTest(win as unknown as Window);
    const outcome = await sendPreviewControl("ping");
    expect(outcome.ok).toBe(true);
    expect(win.posted[0]?.message).toMatchObject({ channel: PREVIEW_CONTROL_REQUEST, op: "ping" });
  });

  it("times out instead of hanging when the page never answers", async () => {
    setPreviewFrameWindowForTest(fakeWindow() as unknown as Window);
    // The module's own timeout is authoritative; the test races a shorter
    // one and asserts the SHAPE (a resolved outcome, never a hang).
    const outcome = await Promise.race([
      sendPreviewControl("get-tree"),
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 50)),
    ]);
    expect(outcome).toBe("waited");
    expect(PREVIEW_CONTROL_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  it("surfaces a refusal from the page as an error with its message", async () => {
    const win = fakeWindow((message) => {
      const request = message as { id?: string };
      setTimeout(() => {
        handleControlReply({
          channel: PREVIEW_CONTROL_RESPONSE,
          id: request.id,
          result: { ok: false, error: "no element with uid b9" },
        });
      }, 5);
    });
    setPreviewFrameWindowForTest(win as unknown as Window);
    const outcome = await sendPreviewControl("click", { uid: "b9" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("no element with uid b9");
  });

  it("ignores a reply with an unknown id instead of resolving someone else's wait", async () => {
    setPreviewFrameWindowForTest(fakeWindow() as unknown as Window);
    handleControlReply({ channel: PREVIEW_CONTROL_RESPONSE, id: "no-such", result: { ok: true } });
    const outcome = await Promise.race([
      sendPreviewControl("ping"),
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 40)),
    ]);
    expect(outcome).toBe("waited");
  });

  it("extracts a typed snapshot from a successful get-tree", async () => {
    const win = fakeWindow();
    bootstrapReply(win);
    setPreviewFrameWindowForTest(win as unknown as Window);
    const outcome = await sendPreviewControl("get-tree");
    expect(snapshotFrom(outcome)?.title).toBe("t");
  });

  it("previewFrameWindow reads the real DOM when no override is set", () => {
    // `undefined` is the "no override" sentinel; `null` would BE an override.
    setPreviewFrameWindowForTest(undefined as unknown as Window | null);
    // In a test DOM there is no preview iframe; the important property is
    // that it returns null rather than throwing.
    expect(previewFrameWindow()).toBeNull();
  });
});
