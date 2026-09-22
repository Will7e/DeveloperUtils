// ============================================================
// Agent Panel Visibility — Regression Tests
// ============================================================
// The panel's visibility is derived from the repo attachment, not
// toggled by a button, and the one time that went wrong the panel
// simply never appeared on its own — a silent failure, because a
// missing panel looks exactly like a panel the user never opened.
// These tests pin the rule itself.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { isAgentPanelVisible, usePreviewStore } from "./preview.store";

// Evicting a cached build has to reach the host that is serving its
// document; a spy is how that becomes observable here.
const { releaseLivePreview } = vi.hoisted(() => ({ releaseLivePreview: vi.fn() }));
vi.mock("./host/preview-host-client", () => ({ releaseLivePreview }));

describe("isAgentPanelVisible", () => {
  it("opens the panel as soon as a repository is attached", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 1000, closedForAttachment: null })
    ).toBe(true);
  });

  it("stays closed for the attachment the user dismissed", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 1000, closedForAttachment: 1000 })
    ).toBe(false);
  });

  it("reopens when the panel is asked for again (stamp cleared)", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 1000, closedForAttachment: null })
    ).toBe(true);
  });

  it("reopens for a NEW attachment even though an older one was dismissed", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 2000, closedForAttachment: 1000 })
    ).toBe(true);
  });

  it("never shows without a repository — there is no workspace to report on", () => {
    expect(
      isAgentPanelVisible({ repoAttached: false, attachedAt: 0, closedForAttachment: null })
    ).toBe(false);
    expect(
      isAgentPanelVisible({ repoAttached: false, attachedAt: 0, closedForAttachment: 1000 })
    ).toBe(false);
  });
});

// ============================================================
// One Build, One Owner
// ============================================================
// The store was a single slot. Two consequences, both reported as "the
// preview is broken": switching chats WIPED the document (so coming back
// re-ran esbuild-wasm and the app lost its state), and a build that finished
// after a switch wrote its document into whichever thread was on screen, so
// the pane could show another chat's app.
//
// The rule these tests pin: a build is filed under the conversation that
// asked for it, and the view is only ever changed by a build that owns it.

function documentFor(marker: string): string {
  return `<!doctype html><html><body>${marker}</body></html>`;
}

function build(conversationId: string, marker: string, status: "ready" | "error" = "ready") {
  usePreviewStore.getState().setBuild({
    conversationId,
    html: status === "ready" ? documentFor(marker) : null,
    url: `http://127.0.0.1:5174/${marker}`,
    entry: "src/main.tsx",
    diagnostics: status === "error" ? [{ message: marker, severity: "error" }] : [],
    status,
    jsHash: marker,
    css: `.${marker}{}`,
    delivery: "hosted",
    deliveryNotice: `served ${marker}`,
  });
}

describe("preview store — per-conversation builds", () => {
  beforeEach(() => {
    usePreviewStore.setState({
      conversationId: null,
      builds: {},
      status: "idle",
      html: null,
      url: null,
      entry: null,
      diagnostics: [],
      console: [],
      consoleSeq: 1,
      jsHash: "",
      css: "",
      delivery: "inline",
      deliveryNotice: null,
      builtAt: 0,
      runtimeReady: false,
      screenshot: null,
    });
  });

  it("shows a build that belongs to the conversation on screen", () => {
    const store = usePreviewStore.getState();
    store.setConversation("a");
    build("a", "alpha");
    expect(usePreviewStore.getState().html).toBe(documentFor("alpha"));
    expect(usePreviewStore.getState().status).toBe("ready");
  });

  it("never shows one conversation's build in another conversation", () => {
    // The leak: a background build landing after the user switched.
    usePreviewStore.getState().setConversation("a");
    build("a", "alpha");
    usePreviewStore.getState().setConversation("b");

    build("a", "alpha-rebuilt");
    expect(usePreviewStore.getState().html).toBeNull();
    expect(usePreviewStore.getState().builds.a?.html).toBe(documentFor("alpha-rebuilt"));

    // …and it is waiting, already built, when the user comes back.
    usePreviewStore.getState().setConversation("a");
    expect(usePreviewStore.getState().html).toBe(documentFor("alpha-rebuilt"));
  });

  it("makes switching back a view change, not a rebuild", () => {
    usePreviewStore.getState().setConversation("a");
    build("a", "alpha");
    usePreviewStore.getState().addConsole([{ level: "error", text: "boom from alpha" }]);

    usePreviewStore.getState().setConversation("b");
    expect(usePreviewStore.getState().html).toBeNull();

    usePreviewStore.getState().setConversation("a");
    const back = usePreviewStore.getState();
    expect(back.html).toBe(documentFor("alpha"));
    expect(back.url).toBe("http://127.0.0.1:5174/alpha");
    expect(back.delivery).toBe("hosted");
    // Its own console comes back with it — the diagnostics that belong to
    // the thread you are looking at, not whatever the last frame said.
    expect(back.console.map((e) => e.text)).toEqual(["boom from alpha"]);
    // The frame has to be mounted again: nothing is running yet.
    expect(back.runtimeReady).toBe(false);
  });

  it("restores a per-thread failure, so a broken build is still explained", () => {
    usePreviewStore.getState().setConversation("a");
    build("b", "b-broken", "error");
    usePreviewStore.getState().setConversation("b");
    const state = usePreviewStore.getState();
    expect(state.status).toBe("error");
    expect(state.diagnostics.map((d) => d.message)).toEqual(["b-broken"]);
    expect(state.html).toBeNull();
  });

  it("keeps a background thread's status out of the visible badge", () => {
    usePreviewStore.getState().setConversation("a");
    build("a", "alpha");
    usePreviewStore.getState().setStatus("building", "b");
    expect(usePreviewStore.getState().status).toBe("ready");
    expect(usePreviewStore.getState().builds.b?.status).toBe("building");

    // And the badge the user sees when they arrive is the real one.
    usePreviewStore.getState().setConversation("b");
    expect(usePreviewStore.getState().status).toBe("building");
  });

  it("starts a never-built conversation clean instead of inheriting a document", () => {
    usePreviewStore.getState().setConversation("a");
    build("a", "alpha");
    usePreviewStore.getState().setConversation("fresh");
    const state = usePreviewStore.getState();
    expect(state.status).toBe("idle");
    expect(state.html).toBeNull();
    expect(state.diagnostics).toEqual([]);
  });

  it("holds a bounded number of documents, and never drops the one on screen", () => {
    // A snapshot carries the whole built document, so an unbounded map is a
    // leak with a slow fuse. The visible thread must survive eviction: an
    // empty pane would be a worse outcome than a rebuild.
    usePreviewStore.getState().setConversation("a");
    for (let i = 0; i < 20; i++) {
      const id = `thread-${i}`;
      usePreviewStore.getState().setConversation(id);
      build(id, id);
    }
    const cached = Object.keys(usePreviewStore.getState().builds);
    expect(cached.length).toBeLessThanOrEqual(6);
    expect(cached).toContain("thread-19");
    expect(cached).not.toContain("thread-0");
  });

  it("releases the published document of every build it drops", () => {
    // A cache eviction that does not reach the host leaves a readable copy of
    // the user's source being served with nothing in the app pointing at it.
    releaseLivePreview.mockClear();
    usePreviewStore.getState().setConversation("a");
    for (let i = 0; i < 20; i++) {
      const id = `thread-${i}`;
      usePreviewStore.getState().setConversation(id);
      build(id, id);
    }

    const released = releaseLivePreview.mock.calls.map((call) => call[0]?.key);
    expect(released).toContain("thread-0");
    // …and never the thread on screen: its document is what the frame shows.
    expect(released).not.toContain("thread-19");
  });

  it("bumps buildId on a switch, so probe results cannot describe the old thread", () => {
    // preview-bridge invalidates its probe cache on a buildId change; two
    // conversations are two different documents, whatever their JS hash says.
    usePreviewStore.getState().setConversation("a");
    build("a", "alpha");
    const before = usePreviewStore.getState().buildId;
    usePreviewStore.getState().setConversation("b");
    expect(usePreviewStore.getState().buildId).toBeGreaterThan(before);
  });
});
