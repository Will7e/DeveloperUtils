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
// module owns the layout, the colors and the element boilerplate. It draws
// the board the way the app's OWN board is drawn (see
// createDefaultWorkflowElements in stores/app.store), because "a diagram the
// agent drew" and "a diagram the app ships" should not look like two
// different products:
//
//   • SAME ORIGIN. The sample board puts its content at (280, 140); this
//     module starts there too. A board drawn from the canvas origin opens
//     jammed into the top-left corner, with the title hidden under the
//     floating toolbar and nothing where the user is looking.
//   • TINTED FILLS, NEUTRAL LABELS. A node is a shape stroked in its column's
//     color with an 8%-opacity fill of the same color, and its text is the
//     same near-black the sample board uses. Excalidraw's dark theme
//     inverts near-black (and the near-white it maps to), so #1e1e1e is
//     readable in BOTH themes; a label tinted with its node's color is not
//     (a bright green label on a dark canvas is the failure this avoids).
//   • EDGE-ANCHORED ARROWS. Arrows are drawn from the source box's border to
//     the target's, never center-to-center: a center-to-center line crosses
//     the boxes it connects and strikes through their labels.
//   • SCOPED IDS. Element ids are prefixed AND scoped, so two diagrams can
//     live on one board. Unscoped ids collide (every diagram wanted
//     `agent-edge-0`), and Excalidraw merges elements that share an id —
//     the second diagram loses its arrows with no error anywhere.
//
// Three deliberate simplifications, each a correctness choice rather than a
// shortcut:
//
//   • labels are FREE TEXT placed over the shape, not `containerId`-bound
//     text. Binding is the fragile half of the format (both sides must agree
//     on ids in `boundElements`/`containerId`), and an unbound label renders
//     identically until someone drags the box.
//   • arrows carry absolute points and no `startBinding`/`endBinding`. A bound
//     arrow re-routes when its shape moves; an unbound one simply does not.
//     A wrong binding, by contrast, drops the arrow off the canvas entirely —
//     the failure mode this deliberately avoids.
//
// Layout is layered (longest-path depth → column) and fully deterministic:
// the same spec (and scope) always produces the same board, which is what
// makes it diffable and testable.

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

export interface DiagramBuildOptions {
  /**
   * Element-id scope. Pass a short stable token (a board id, a timestamp
   * base36) so two generated diagrams on one board keep disjoint ids.
   * Omitted → the legacy unscoped ids, which is what the layout tests use.
   */
  scope?: string;
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
/**
 * Where a generated diagram starts on the board.
 *
 * Deliberately the same working area the app's own sample board uses
 * (createDefaultWorkflowElements places its title at 280/140 and its first
 * box at 280/250): a board drawn at the canvas origin lands under the
 * floating toolbar, half off-screen, which reads as a broken diagram rather
 * than a positioned one.
 */
const ORIGIN_X = 280;
const ORIGIN_Y = 140;
/** Gap between the title baseline and the first row of boxes */
const TITLE_GAP = 110;

/** Palette cycled by column, so layers read as groups */
const PALETTE = ["#0070f3", "#00df8f", "#8e4ec6", "#f5a623", "#3291ff", "#f43f5e"];

/** Label text color: the sample board's neutral, theme-safe in both modes */
const LABEL_COLOR = "#1e1e1e";
/** Board title color */
const TITLE_COLOR = "#a1a1a1";
/** Opacity of a node's fill, appended as a hex alpha (8%, like the sample) */
const FILL_ALPHA = "14";
/** Text metrics: fontSize 16 at lineHeight 1.25 */
const LINE_HEIGHT_PX = 20;

/** One layout slot for a node */
interface Placed extends DiagramNode {
  col: number;
  row: number;
  x: number;
  y: number;
}

/** Element ids for one generated diagram, scoped so boards can coexist */
interface DiagramIds {
  title: string;
  node: (nodeId: string) => string;
  label: (nodeId: string) => string;
  edge: (index: number) => string;
}

function idsFor(scope?: string): DiagramIds {
  const prefix = scope ? `agent-${scope}-` : "agent-";
  return {
    title: `${prefix}diagram-title`,
    node: (nodeId) => `${prefix}node-${nodeId}`,
    label: (nodeId) => `${prefix}node-${nodeId}-label`,
    edge: (index) => `${prefix}edge-${index}`,
  };
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
      x: ORIGIN_X + col * (NODE_W + COL_GAP),
      y: ORIGIN_Y + TITLE_GAP + row * (NODE_H + ROW_GAP),
    };
  });
}

/** A rectangle the label sits on, in Excalidraw's element shape */
function rectElement(placed: Placed, index: number, ids: DiagramIds): Record<string, unknown> {
  const color = PALETTE[placed.col % PALETTE.length]!;
  return {
    type: "rectangle",
    version: 1,
    versionNonce: 1000 + index,
    isDeleted: false,
    id: ids.node(placed.id),
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: placed.x,
    y: placed.y,
    strokeColor: color,
    // Tinted, not transparent: the fill is what makes a column read as a
    // group at a glance, and it is what the app's own board does.
    backgroundColor: `${color}${FILL_ALPHA}`,
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
function textElement(placed: Placed, index: number, ids: DiagramIds): Record<string, unknown> {
  // Clamped here rather than trusting the caller: this module owns the box
  // width, so it owns the rule that one long string cannot overrun it (a
  // wrapped line is fine, an unbounded one is a layout that reads as broken).
  const label = clamp(placed.label, DIAGRAM_MAX_LABEL_CHARS);
  const detail = placed.detail ? clamp(placed.detail, DIAGRAM_MAX_LABEL_CHARS) : "";
  const text = detail ? `${label}\n${detail}` : label;
  const height = detail ? LINE_HEIGHT_PX * 2 : LINE_HEIGHT_PX;
  return {
    type: "text",
    version: 1,
    versionNonce: 2000 + index,
    isDeleted: false,
    id: ids.label(placed.id),
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: placed.x + 10,
    y: placed.y + NODE_H / 2 - height / 2,
    // Neutral, not the node's color: the shape carries the color, the text
    // carries the words. Colored labels also fail contrast in dark mode.
    strokeColor: LABEL_COLOR,
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

/**
 * The point where an arrow leaves one box and lands on another.
 *
 * Anchored to the FACING EDGE rather than to the centers: a center-to-center
 * arrow crosses both boxes and strikes through their labels, which is what
 * made generated diagrams look mispositioned. The layered layout only ever
 * connects neighbours, so the horizontal case is the common one and the
 * vertical cases cover same-column and upward edges.
 */
function anchorPoints(from: Placed, to: Placed): { start: [number, number]; end: [number, number] } {
  const fromCx = from.x + NODE_W / 2;
  const fromCy = from.y + NODE_H / 2;
  const toCx = to.x + NODE_W / 2;
  const toCy = to.y + NODE_H / 2;

  if (to.x >= from.x + NODE_W) {
    return { start: [from.x + NODE_W, fromCy], end: [to.x, toCy] };
  }
  if (to.x + NODE_W <= from.x) {
    return { start: [from.x, fromCy], end: [to.x + NODE_W, toCy] };
  }
  if (to.y >= from.y + NODE_H) {
    return { start: [fromCx, from.y + NODE_H], end: [toCx, to.y] };
  }
  if (to.y + NODE_H <= from.y) {
    return { start: [fromCx, from.y], end: [toCx, to.y + NODE_H] };
  }
  // Overlapping boxes (only possible if the spec names the same node twice,
  // which the caller validates): fall back to center-to-center so the edge is
  // still drawn rather than silently dropped.
  return { start: [fromCx, fromCy], end: [toCx, toCy] };
}

/** An arrow between two placed nodes, drawn edge to edge */
function arrowElement(
  from: Placed,
  to: Placed,
  index: number,
  ids: DiagramIds,
  label?: string
): Record<string, unknown> {
  const { start, end } = anchorPoints(from, to);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  // The source node's color, like the sample board's arrow: it reads as
  // "this edge belongs to that box" without an extra legend.
  const color = PALETTE[from.col % PALETTE.length]!;
  const base: Record<string, unknown> = {
    type: "arrow",
    version: 1,
    versionNonce: 3000 + index,
    isDeleted: false,
    id: ids.edge(index),
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: start[0],
    y: start[1],
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
    endArrowhead: "triangle",
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
function titleElement(title: string, ids: DiagramIds): Record<string, unknown> {
  return {
    type: "text",
    version: 1,
    versionNonce: 900,
    isDeleted: false,
    id: ids.title,
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: ORIGIN_X,
    y: ORIGIN_Y,
    strokeColor: TITLE_COLOR,
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
export function buildDiagramElements(
  spec: DiagramSpec,
  options: DiagramBuildOptions = {}
): unknown[] {
  const ids = idsFor(options.scope);
  const placed = layout(spec);
  const byId = new Map(placed.map((p) => [p.id, p]));
  const elements: unknown[] = [];

  if (spec.title) elements.push(titleElement(clamp(spec.title, 80), ids));
  placed.forEach((node, index) => {
    elements.push(rectElement(node, index, ids));
    elements.push(textElement(node, index, ids));
  });
  spec.edges.forEach((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;
    elements.push(arrowElement(from, to, index, ids, edge.label ? clamp(edge.label, 40) : undefined));
  });

  return elements;
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
