// ============================================================
// Preview Control — bootstrap, serializer, injection
// ============================================================
// Pure-logic tests: the outline serializer over a DOM-ish fixture, the
// injection's idempotence and placement, and the uids that make a snapshot
// actionable. The message channel itself needs a real iframe, which is the
// runtime spike — these tests cover everything that does not.
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PREVIEW_CONTROL_PROTOCOL_VERSION,
  PREVIEW_SNAPSHOT_MAX_NODES,
  bootstrapSource,
  formatOutline,
  injectBootstrap,
  looksLikeHtmlDocument,
  serializeSnapshot,
  type SerializedSnapshot,
} from "./preview-control";
import {
  injectPreviewControl,
  previewControlVersion,
  resetPreviewControl,
} from "./preview-control-bridge";

/** A minimal DOM-ish document fixture the serializer's Element usage covers */
function fakeElement(tag: string, attrs: Record<string, string> = {}, children: (FakeNode | string)[] = []): FakeNode {
  const text =
    children.filter((c): c is string => typeof c === "string").join(" ") ||
    (tag === "img" || tag === "input" ? "" : "");
  return {
    tagName: tag.toUpperCase(),
    attributes: attrs,
    children: children.filter((c): c is FakeNode => typeof c !== "string"),
    textContent: text,
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
  };
}

interface FakeNode {
  tagName: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  textContent: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** Wraps a tree in just enough Document shape for serializeSnapshot */
function fakeDocument(body: FakeNode, title = "App"): unknown {
  return {
    title,
    location: { href: "http://localhost:5173/" },
    body: {
      tagName: "BODY",
      // The serializer only reads tagName/children off the body itself.
      children: [body],
    },
  };
}

describe("serializeSnapshot — the outline the model reads", () => {
  it("gives interactive elements stable, per-tag uids in document order", () => {
    const doc = fakeDocument(
      fakeElement("div", {}, [
        fakeElement("button", {}, ["Save"]),
        fakeElement("a", { href: "/x" }, ["Docs"]),
        fakeElement("input", { type: "text", placeholder: "Email" }),
        fakeElement("img", { alt: "Logo" }),
      ])
    ) as Document;
    const snapshot = serializeSnapshot(doc);
    const uids = snapshot.nodes.filter((n) => n.uid).map((n) => n.uid);
    // Per-tag counters: b1 (the button), a1 (the anchor), i1 (the input).
    // Images are read-only evidence, not interactive — alt text is the
    // label and no uid is spent on them. The prefix names the kind.
    expect(uids).toEqual(["b1", "a1", "i1"]);
  });

  it("labels an input by its placeholder and an image by its alt", () => {
    const doc = fakeDocument(
      fakeElement("div", {}, [
        fakeElement("input", { type: "text", placeholder: "Email" }),
        fakeElement("img", { alt: "Logo" }),
      ])
    ) as Document;
    const snapshot = serializeSnapshot(doc);
    const labels = snapshot.nodes.map((n) => n.label);
    expect(labels).toContain("input \u201cEmail\u201d");
    expect(labels).toContain("Logo");
  });

  it("skips script and style contents entirely", () => {
    const doc = fakeDocument(
      fakeElement("div", {}, [
        fakeElement("script", {}, ["window.payload = { user: ' instructions here' };"]),
        fakeElement("style", {}, [".injected { color: red }"]),
        fakeElement("p", {}, ["Visible text"]),
      ])
    ) as Document;
    const snapshot = serializeSnapshot(doc);
    expect(snapshot.nodes.map((n) => n.label)).toEqual(["Visible text"]);
  });

  it("counts truncation instead of dropping silently", () => {
    const children: FakeNode[] = [];
    for (let i = 0; i < PREVIEW_SNAPSHOT_MAX_NODES + 50; i += 1) {
      children.push(fakeElement("p", {}, [`para ${i}`]));
    }
    const doc = fakeDocument(fakeElement("div", {}, children)) as Document;
    const snapshot = serializeSnapshot(doc);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.length).toBe(PREVIEW_SNAPSHOT_MAX_NODES);
    expect(snapshot.totalNodes).toBeGreaterThan(PREVIEW_SNAPSHOT_MAX_NODES);
  });

  it("reports an empty body as an empty outline, not an error", () => {
    const doc = fakeDocument(fakeElement("div", {}, [])) as Document;
    const snapshot = serializeSnapshot(doc);
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.truncated).toBe(false);
  });
});

describe("formatOutline — indentation and caps", () => {
  it("indents by depth and marks uids", () => {
    const snapshot: SerializedSnapshot = {
      nodes: [
        { uid: null, kind: "heading", label: "Settings", depth: 0 },
        { uid: "i1", kind: "input", label: "input \u201cName\u201d", depth: 2 },
      ],
      totalNodes: 2,
      truncated: false,
      title: "App",
      url: "http://x",
    };
    const outline = formatOutline(snapshot);
    expect(outline).toContain("# App");
    expect(outline).toContain("- heading: Settings");
    expect(outline).toContain("    - input [i1]: input \u201cName\u201d");
  });

  it("states the truncation in words", () => {
    const snapshot: SerializedSnapshot = {
      nodes: [],
      totalNodes: 500,
      truncated: true,
      title: "",
      url: "",
    };
    expect(formatOutline(snapshot)).toContain("500 elements");
  });
});

describe("injectBootstrap — placement and idempotence", () => {
  it("injects right after <head> and carries the version marker", () => {
    const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
    const out = injectBootstrap(html);
    expect(out).toContain(`data-intab-preview-control="${PREVIEW_CONTROL_PROTOCOL_VERSION}"`);
    const markerAt = out.indexOf("data-intab-preview-control");
    const headAt = out.indexOf("<head>");
    expect(markerAt).toBeGreaterThan(headAt);
    expect(markerAt).toBeLessThan(out.indexOf("<title>"));
  });

  it("is idempotent — a re-mounted revision never stacks a second listener", () => {
    const html = "<html><head></head><body></body></html>";
    const once = injectBootstrap(html);
    expect(injectBootstrap(once)).toBe(once);
  });

  it("injects into a fragment with no head", () => {
    const out = injectBootstrap("<div>hi</div>");
    expect(out).toContain("data-intab-preview-control");
    expect(out.indexOf("script")).toBeLessThan(out.indexOf("<div>"));
  });

  it("the bootstrap source parses as standalone JavaScript (no imports)", () => {
    const source = bootstrapSource();
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).toContain("window.__intabPreviewControl");
    // The double-run guard is the idempotence at runtime:
    expect(source).toContain("if (window.__intabPreviewControl) return;");
  });
});

describe("looksLikeHtmlDocument — what is worth injecting into", () => {
  it("accepts a doctype or an html element", () => {
    expect(looksLikeHtmlDocument("<!doctype html><html></html>")).toBe(true);
    expect(looksLikeHtmlDocument("<html lang=\"en\"></html>")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(looksLikeHtmlDocument("console.log('server')")).toBe(false);
    expect(looksLikeHtmlDocument("")).toBe(false);
  });
});

describe("injectPreviewControl — the mount-plan seam", () => {
  beforeEach(() => resetPreviewControl());
  afterEach(() => resetPreviewControl());

  it("rewrites the plan's index.html in place and reports it", () => {
    const tree = {
      src: { directory: { "index.html": { file: { contents: "<html><head></head><body></body></html>" } } } },
    };
    const plan = { tree, files: [{ path: "src/index.html", bytes: 37 }] };
    const result = injectPreviewControl(plan as never);
    expect(result.injected).toBe(true);
    expect((tree.src.directory["index.html"] as { file: { contents: string } }).file.contents).toContain(
      "data-intab-preview-control"
    );
    expect(plan.files[0]!.bytes).toBeGreaterThan(37);
  });

  it("is silent when there is no index.html to inject into", () => {
    const plan = { tree: { "main.py": { file: { contents: "print(1)" } } }, files: [] };
    const result = injectPreviewControl(plan as never);
    expect(result.injected).toBe(false);
    expect(result.note).toBeNull();
  });

  it("reports the protocol version this host speaks", () => {
    expect(previewControlVersion()).toBe(PREVIEW_CONTROL_PROTOCOL_VERSION);
  });
});
