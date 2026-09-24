// ============================================================
// Diagram Elements — What The Agent's Board Looks Like
// ============================================================
// These tests are about the DIFFERENCES between a generated board and a
// blank one: where the content lands, what carries the color, where an arrow
// starts, and whether two generated diagrams can share a board. Each of them
// was a visible defect — a diagram opening under the toolbar, a green label
// nobody could read, an arrow struck through its own boxes, a second diagram
// losing its arrows to an id collision.

import { describe, expect, it } from "vitest";

import {
  DIAGRAM_MAX_LABEL_CHARS,
  buildDiagramElements,
  type DiagramSpec,
} from "./diagram-elements";

type El = Record<string, unknown>;

function build(spec: DiagramSpec, scope?: string): El[] {
  return buildDiagramElements(spec, scope ? { scope } : {}) as El[];
}

const SPEC: DiagramSpec = {
  title: "Request flow",
  nodes: [
    { id: "ui", label: "Client" },
    { id: "api", label: "API", detail: "Node" },
    { id: "db", label: "Postgres" },
  ],
  edges: [
    { from: "ui", to: "api", label: "HTTPS" },
    { from: "api", to: "db" },
  ],
};

const rects = (els: El[]) => els.filter((e) => e.type === "rectangle");
const texts = (els: El[]) => els.filter((e) => e.type === "text");
const arrows = (els: El[]) => els.filter((e) => e.type === "arrow");
const byId = (els: El[], id: string) => els.find((e) => e.id === id)!;

describe("layout", () => {
  it("starts in the board's working area, not at the canvas origin", () => {
    // The canvas origin sits under the floating toolbar and the app header,
    // which is what made a generated diagram look clipped and mispositioned.
    const [first] = rects(build(SPEC));
    expect(first!.x as number).toBeGreaterThanOrEqual(200);
    expect(first!.y as number).toBeGreaterThanOrEqual(200);
  });

  it("draws the title above the first row of boxes", () => {
    const els = build(SPEC);
    const title = texts(els).find((t) => t.id === "agent-diagram-title")!;
    const [first] = rects(els);
    expect((title.y as number) + (title.height as number)).toBeLessThanOrEqual(first!.y as number);
  });

  it("layers nodes left to right by dependency depth", () => {
    const [ui, api, db] = rects(build(SPEC));
    expect(ui!.x as number).toBeLessThan(api!.x as number);
    expect(api!.x as number).toBeLessThan(db!.x as number);
    // Same layer, same row.
    expect(ui!.y).toBe(api!.y);
  });

  it("centres a label on its box, including a two-line one", () => {
    const els = build(SPEC);
    const api = byId(els, "agent-node-api");
    const label = byId(els, "agent-node-api-label");
    const boxCentre = (api.y as number) + (api.height as number) / 2;
    expect(label.y).toBe(boxCentre - (label.height as number) / 2);
    expect(label.text).toBe("API\nNode");
  });
});

describe("color", () => {
  it("tints the fill with the node's own color instead of leaving it transparent", () => {
    for (const rect of rects(build(SPEC))) {
      const stroke = rect.strokeColor as string;
      expect(rect.backgroundColor).toBe(`${stroke}14`);
      expect(rect.backgroundColor).not.toBe("transparent");
    }
  });

  it("keeps every label in the neutral, theme-safe text color", () => {
    // Excalidraw's dark theme inverts near-black and the near-white it maps
    // to, so #1e1e1e reads in both themes; a label tinted with its node's
    // color does not (a bright green label on a dark canvas).
    const els = build(SPEC);
    for (const label of texts(els).filter((t) => t.id !== "agent-diagram-title")) {
      expect(label.strokeColor).toBe("#1e1e1e");
    }
  });

  it("gives each column its own color, so layers read as groups", () => {
    const [ui, api, db] = rects(build(SPEC));
    expect(new Set([ui!.strokeColor, api!.strokeColor, db!.strokeColor]).size).toBe(3);
  });

  it("colors an arrow like the node it leaves", () => {
    const els = build(SPEC);
    const ui = byId(els, "agent-node-ui");
    const [first] = arrows(els);
    expect(first!.strokeColor).toBe(ui.strokeColor);
    expect(first!.endArrowhead).toBe("triangle");
  });
});

describe("arrows", () => {
  it("runs edge to edge rather than center to center", () => {
    // A center-to-center arrow crosses both boxes and strikes through their
    // labels, which is what a generated diagram used to look like.
    const els = build(SPEC);
    const ui = byId(els, "agent-node-ui");
    const api = byId(els, "agent-node-api");
    const arrow = byId(els, "agent-edge-0");
    const points = arrow.points as number[][];

    expect(arrow.x).toBe((ui.x as number) + (ui.width as number)); // leaves ui's right edge
    expect(arrow.y).toBe((ui.y as number) + (ui.height as number) / 2);
    expect((arrow.x as number) + points[1]![0]!).toBe(api.x); // lands on api's left edge
    expect(points[1]![1]).toBe(0);
  });

  it("drops down when the target is below rather than to the right", () => {
    const els = build({
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      // b depends on a, so it layers at column 1; this edge goes a → b in the
      // same column instead, which is the vertical case.
      edges: [{ from: "b", to: "b" }],
    });
    const a = byId(els, "agent-node-a");
    const b = byId(els, "agent-node-b");
    expect(a.x).toBe(b.x);
  });

  it("carries its label on the arrow rather than as a loose text element", () => {
    const els = build(SPEC);
    const arrow = byId(els, "agent-edge-0");
    expect((arrow.label as { text: string }).text).toBe("HTTPS");
    expect(texts(els).some((t) => t.text === "HTTPS")).toBe(false);
  });
});

describe("ids", () => {
  it("uses the legacy unscoped ids when no scope is given", () => {
    const els = build(SPEC);
    expect(els.map((e) => e.id)).toEqual([
      "agent-diagram-title",
      "agent-node-ui",
      "agent-node-ui-label",
      "agent-node-api",
      "agent-node-api-label",
      "agent-node-db",
      "agent-node-db-label",
      "agent-edge-0",
      "agent-edge-1",
    ]);
  });

  it("is deterministic for one scope", () => {
    expect(build(SPEC, "s1").map((e) => e.id)).toEqual(build(SPEC, "s1").map((e) => e.id));
  });

  it("shares no id between two scopes, so two diagrams can live on one board", () => {
    const one = new Set(build(SPEC, "s1").map((e) => e.id));
    const two = build(SPEC, "s2").map((e) => e.id);
    expect(two.some((id) => one.has(id))).toBe(false);
    // Every element of one diagram is still present in the other: the ids
    // differ, the shape of the board does not.
    expect(two).toHaveLength(one.size);
  });
});

describe("clamping", () => {
  it("truncates an over-long label instead of letting it blow out the layout", () => {
    const els = build({
      nodes: [
        { id: "a", label: "x".repeat(DIAGRAM_MAX_LABEL_CHARS + 40) },
        { id: "b", label: "B", detail: "y".repeat(DIAGRAM_MAX_LABEL_CHARS + 40) },
      ],
      edges: [],
    });
    for (const line of String(byId(els, "agent-node-a-label").text).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(DIAGRAM_MAX_LABEL_CHARS);
    }
    // The detail line is capped too: a long second line is as damaging as a
    // long first one, and it is the field a model fills with prose.
    for (const line of String(byId(els, "agent-node-b-label").text).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(DIAGRAM_MAX_LABEL_CHARS);
    }
  });

  it("ignores edges that name a node the diagram does not have", () => {
    const els = build({
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "ghost" }],
    });
    expect(arrows(els)).toHaveLength(0);
  });
});
