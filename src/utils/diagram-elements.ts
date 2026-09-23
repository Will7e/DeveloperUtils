// ============================================================
// Diagram Elements — A Simple Node/Edge Spec → Excalidraw Elements
// ============================================================
// DrawFlows is an Excalidraw canvas, and an Excalidraw scene is a list of
// low-level elements (rectangles, free text, arrows) with a dozen required
// fields each. Handing that format to an agent would be a trap: one missing
// field is a blank board, and nothing about "versionNonce" is a thing the
// model can reason about.
//
// So the model describes the SHAPE of a diagram — nodes and edges — and this
// module owns the layout and the element boilerplate. Three deliberate
// simplifications, each a correctness choice rather than a shortcut:
//
//   • labels are FREE TEXT placed over the shape, not `containerId`-bound
//     text. Binding is the fragile half of the format (both sides must agree
//     on ids in `boundElements`/`containerId`), and an unbound label renders
//     identically until someone drags the box.
//   • arrows carry absolute points and no `startBinding`/`endBinding`. A bound
//     arrow re-routes when its shape moves; an unbound one simply does not.
//     A wrong binding, by contrast, drops the arrow off the canvas entirely —
//     the failure mode this deliberately avoids.
//   • all ids are prefixed, so a generated scene can never collide with the
//     user's own elements on a board they already had open.
//
// Layout is layered (BFS depth → column) and fully deterministic: the same
// spec always produces the same board, which is what makes it diffable and
// testable.

export interface DiagramNode {
  id: string;
  label: string;
  /** Optional second line, used as the shape's caption */
  detail?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Board title, drawn above the diagram */
  title?: string;
}

/** Hard caps: a diagram is an explanation, not a data dump */
export const DIAGRAM_MAX_NODES = 40;
export const DIAGRAM_MAX_EDGES = 80;
export const DIAGRAM_MAX_LABEL_CHARS = 120;

/** Shape + spacing constants (Excalidraw scene units) */
const NODE_W = 180;
const NODE_H = 70;
const COL_GAP = 90;
const ROW_GAP = 55;
const MARGIN = 40;

/** Palette cycled by column, so layers read as groups */
const PALETTE = ["#0070f3", "#00df8f", "#8e4ec6", "#f5a623", "#3291ff", "#f43f5e"];

/** One layout slot for a node */
interface Placed extends DiagramNode {
  col: number;
  row: number;
  x: number;
  y: number;
}

/**
 * Assigns each node a column by its longest-path depth. Edges pointing at
 * unknown nodes are ignored (the spec is validated first), and a cycle leaves
 * the remaining nodes in input order in the columns they already had — a
 * diagram that is merely flatter is better than one that is missing nodes.
 */
function layout(spec: DiagramSpec): Placed[] {
  const known = new Map(spec.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of spec.nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of spec.edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const depth = new Map<string, number>();
  for (const node of spec.nodes) depth.set(node.id, 0);

  // Relaxation instead of Kahn's algorithm: bounded by node count, and it
  // degrades gracefully (worst case every node ends in column 0) rather than
  // looping forever on a cycle.
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    let changed = false;
    for (const node of spec.nodes) {
      for (const next of outgoing.get(node.id) ?? []) {
        const candidate = (depth.get(node.id) ?? 0) + 1;
        if (candidate > (depth.get(next) ?? 0) && candidate < spec.nodes.length) {
          depth.set(next, candidate);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const perColumn = new Map<number, number>();
  return spec.nodes.map((node) => {
    const col = depth.get(node.id) ?? 0;
    const row = perColumn.get(col) ?? 0;
    perColumn.set(col, row + 1);
    return {
      ...node,
      col,
      row,
      x: MARGIN + col * (NODE_W + COL_GAP),
      y: MARGIN + row * (NODE_H + ROW_GAP),
    };
  });
}

/** A rectangle the label sits on, in Excalidraw's element shape */
function rectElement(placed: Placed, index: number): Record<string, unknown> {
  const color = PALETTE[placed.col % PALETTE.length]!;
  return {
    type: "rectangle",
    version: 1,
    versionNonce: 1000 + index,
    isDeleted: false,
    id: `agent-node-${placed.id}`,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: placed.x,
    y: placed.y,
    strokeColor: color,
    backgroundColor: "transparent",
    width: NODE_W,
    height: NODE_H,
    seed: 10000 + index,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  };
}

/** Free text for one node: label (and optional detail) centered on the box */
function textElement(placed: Placed, index: number): Record<string, unknown> {
  const color = PALETTE[placed.col % PALETTE.length]!;
  const text = placed.detail ? `${placed.label}\n${placed.detail}` : placed.label;
  const height = placed.detail ? 34 : 20;
  return {
    type: "text",
    version: 1,
    versionNonce: 2000 + index,
    isDeleted: false,
    id: `agent-node-${placed.id}-label`,
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: placed.x + 10,
    y: placed.y + NODE_H / 2 - height / 2,
    strokeColor: color,
    backgroundColor: "transparent",
    width: NODE_W - 20,
    height,
    seed: 20000 + index,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text,
    fontSize: 16,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: 14,
    containerId: null,
    originalText: text,
    lineHeight: 1.25,
  };
}

/** An arrow between two placed nodes, drawn center-to-center */
function arrowElement(
  from: Placed,
  to: Placed,
  index: number,
  label?: string
): Record<string, unknown> {
  const fx = from.x + NODE_W / 2;
  const fy = from.y + NODE_H / 2;
  const tx = to.x + NODE_W / 2;
  const ty = to.y + NODE_H / 2;
  const dx = tx - fx;
  const dy = ty - fy;
  const color = "#a1a1a1";
  const base: Record<string, unknown> = {
    type: "arrow",
    version: 1,
    versionNonce: 3000 + index,
    isDeleted: false,
    id: `agent-edge-${index}`,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: fx,
    y: fy,
    strokeColor: color,
    backgroundColor: "transparent",
    width: Math.abs(dx),
    height: Math.abs(dy),
    seed: 30000 + index,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    points: [
      [0, 0],
      [dx, dy],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    // Elbowed orthogonal routing reads better for architecture than a
    // straight diagonal, and it is a plain property rather than a bound
    // behaviour.
    elbowed: true,
  };
  if (!label) return base;
  return {
    ...base,
    // The label rides as a property of the arrow (Excalidraw's own shape for
    // it) rather than as a separate text element, so it cannot be orphaned.
    label: {
      text: label,
      fontSize: 14,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: color,
      backgroundColor: "transparent",
      groupIds: [],
    },
  };
}

/** A title drawn above the diagram */
function titleElement(title: string): Record<string, unknown> {
  return {
    type: "text",
    version: 1,
    versionNonce: 900,
    isDeleted: false,
    id: "agent-diagram-title",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: MARGIN,
    y: 0,
    strokeColor: "#a1a1a1",
    backgroundColor: "transparent",
    width: Math.max(160, title.length * 9),
    height: 24,
    seed: 900,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    text: title,
    fontSize: 18,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 16,
    containerId: null,
    originalText: title,
    lineHeight: 1.25,
  };
}

/**
 * Builds a complete Excalidraw scene from a node/edge spec.
 *
 * Nodes are drawn left-to-right by dependency depth; edges that name an
 * unknown node are dropped (callers surface that as a warning), and every
 * label is clamped so one long string cannot blow out the layout.
 */
export function buildDiagramElements(spec: DiagramSpec): unknown[] {
  const placed = layout(spec);
  const byId = new Map(placed.map((p) => [p.id, p]));
  const elements: unknown[] = [];

  if (spec.title) elements.push(titleElement(clamp(spec.title, 80)));
  placed.forEach((node, index) => {
    elements.push(rectElement(node, index));
    elements.push(textElement(node, index));
  });
  spec.edges.forEach((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;
    elements.push(arrowElement(from, to, index, edge.label ? clamp(edge.label, 40) : undefined));
  });

  return elements;
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
