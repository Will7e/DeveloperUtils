// ============================================================
// Preview Layout — Geometry the Agent Can Actually Reason About
// ============================================================
// `query_preview_dom` answers "is this element there with this text".
// It cannot answer the questions that layout bugs actually are: is the
// container collapsed to zero height, is the content spilling out of it,
// did the new section land off-screen, does the page scroll sideways
// because something is 40px too wide.
//
// Those are all questions about GEOMETRY, so this module reports
// geometry: a compact map of boxes plus a short list of findings that
// name the element and the reason.
//
// Why not pixels? The raster path exists (see lib/visual-check.ts), and
// it answers a different question: a picture can catch colour, contrast
// and paint order, which geometry cannot. But a model cannot receive an
// image through a tool result — tool rows are text — so pixels only
// reach the agent via a vision model's written answer, which is one
// extra request and one more narrator to distrust. Geometry costs
// nothing, arrives as text, and is strictly more actionable for the
// class of bug it exists to catch (collapsed, clipped, overflowing,
// off-screen). The two are complementary, not alternatives.
//
// Pure: the in-preview collector gathers raw boxes; everything below is
// analysis and formatting, unit-testable without a browser.

/** One raw box reported by the in-preview collector (compact keys) */
export interface RawBox {
  tag: string;
  id?: string;
  cls?: string;
  /** Viewport-relative rect (rounded px) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** scrollWidth − clientWidth (>0 means horizontally clipped content) */
  ow?: number;
  /** scrollHeight − clientHeight (>0 means vertically clipped content) */
  oh?: number;
  /** computed position (used to excuse deliberate overlaps) */
  pos?: string;
  /** Short text for leaf elements */
  txt?: string;
}

export interface RawLayoutReport {
  viewport: { w: number; h: number };
  /** documentElement scroll size — wider than viewport means sideways scroll */
  document: { w: number; h: number };
  /** Elements considered (before the report cap) */
  total?: number;
  elements: RawBox[];
  /** Set when the collector itself failed (bad selector, no preview) */
  error?: string;
}

export type LayoutCode =
  | "horizontal-page-scroll"
  | "clipped-content"
  | "collapsed-element"
  | "offscreen-element"
  | "wider-than-viewport";

export interface LayoutFinding {
  code: LayoutCode;
  /** Short, actionable sentence naming the element */
  message: string;
}

/**
 * Validates raw postMessage data into a report. The payload crosses a
 * process-ish boundary (an iframe), so it is treated as untrusted input:
 * wrong types are dropped rather than propagated into the analysis.
 */
export function normalizeLayoutReport(raw: unknown): RawLayoutReport {
  const empty: RawLayoutReport = { viewport: { w: 0, h: 0 }, document: { w: 0, h: 0 }, elements: [] };
  if (typeof raw !== "object" || raw === null) return empty;
  const obj = raw as {
    viewport?: { w?: unknown; h?: unknown };
    document?: { w?: unknown; h?: unknown };
    total?: unknown;
    elements?: unknown;
    error?: unknown;
  };

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const elements: RawBox[] = Array.isArray(obj.elements)
    ? obj.elements
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        .map((e) => ({
          tag: typeof e.tag === "string" && e.tag ? e.tag : "?",
          ...(typeof e.id === "string" && e.id ? { id: e.id } : {}),
          ...(typeof e.cls === "string" && e.cls ? { cls: e.cls } : {}),
          x: num(e.x),
          y: num(e.y),
          w: num(e.w),
          h: num(e.h),
          ...(num(e.ow) > 1 ? { ow: num(e.ow) } : {}),
          ...(num(e.oh) > 1 ? { oh: num(e.oh) } : {}),
          ...(typeof e.pos === "string" ? { pos: e.pos } : {}),
          ...(typeof e.txt === "string" ? { txt: e.txt.slice(0, 60) } : {}),
        }))
    : [];

  return {
    viewport: { w: num(obj.viewport?.w), h: num(obj.viewport?.h) },
    document: { w: num(obj.document?.w), h: num(obj.document?.h) },
    ...(typeof obj.total === "number" ? { total: obj.total } : {}),
    elements,
    ...(typeof obj.error === "string" ? { error: obj.error } : {}),
  };
}

/** Human-readable identity for a box, e.g. `div#root > ul.menu` */
export function describeBox(box: RawBox): string {
  const id = box.id ? `#${box.id}` : "";
  const firstClass = box.cls ? box.cls.split(/\s+/)[0] : "";
  return `${box.tag}${id}${firstClass ? `.${firstClass}` : ""}`;
}

/** True when the box occupies real space */
function isVisible(box: RawBox): boolean {
  return box.w >= 1 && box.h >= 1;
}

/**
 * Findings, ordered by severity. Every rule is chosen for precision over
 * recall: a layout audit that cries wolf gets ignored, and the agent
 * will act on whatever it reports.
 */
export function analyzeLayout(report: RawLayoutReport): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  const vw = report.viewport?.w ?? 0;
  const vh = report.viewport?.h ?? 0;
  const docW = report.document?.w ?? 0;
  const boxes = Array.isArray(report.elements) ? report.elements : [];

  if (vw > 0 && docW > vw + 1) {
    findings.push({
      code: "horizontal-page-scroll",
      message: `The page scrolls sideways: the document is ${docW}px wide in a ${vw}px viewport (${docW - vw}px of overflow). Something below is too wide.`,
    });
  }

  for (const box of boxes) {
    const name = describeBox(box);

    if (!isVisible(box)) {
      findings.push({
        code: "collapsed-element",
        message: `${name} is visible but occupies ${Math.round(box.w)}×${Math.round(box.h)}px — it renders as nothing. Check its height/width, its empty children, and any flex/grid sizing on it.`,
      });
    }

    if ((box.ow ?? 0) > 1 || (box.oh ?? 0) > 1) {
      const axes = [
        (box.ow ?? 0) > 1 ? `${Math.round(box.ow!)}px horizontally` : "",
        (box.oh ?? 0) > 1 ? `${Math.round(box.oh!)}px vertically` : "",
      ].filter(Boolean);
      findings.push({
        code: "clipped-content",
        message: `${name} has content spilling ${axes.join(" and ")} outside its box (it is clipping or scrolling). Give it room or let it wrap.`,
      });
    }

    if (vw > 0 && vh > 0 && isVisible(box)) {
      const offscreen =
        box.x + box.w < 0 || box.y + box.h < 0 || box.x > vw || box.y > vh;
      if (offscreen) {
        findings.push({
          code: "offscreen-element",
          message: `${name} sits entirely outside the ${vw}×${vh} viewport (at ${Math.round(box.x)},${Math.round(box.y)}). It is either positioned wrongly or pushed out by a sibling.`,
        });
      } else if (box.w > vw + 1) {
        findings.push({
          code: "wider-than-viewport",
          message: `${name} is ${Math.round(box.w)}px wide — wider than the ${vw}px viewport, so it forces horizontal scrolling.`,
        });
      }
    }
  }

  // One finding per element keeps the report short enough to act on.
  return findings.slice(0, 12);
}

/** The compact text map the model reads */
export function formatLayoutMap(report: RawLayoutReport, maxRows = 40): string[] {
  const boxes = Array.isArray(report.elements) ? report.elements : [];
  return boxes.slice(0, maxRows).map((box) => {
    const size = `${Math.round(box.w)}×${Math.round(box.h)}`;
    const at = `${Math.round(box.x)},${Math.round(box.y)}`;
    const flags = [
      (box.ow ?? 0) > 1 ? `overflow-x ${Math.round(box.ow!)}px` : "",
      (box.oh ?? 0) > 1 ? `overflow-y ${Math.round(box.oh!)}px` : "",
      !isVisible(box) ? "collapsed" : "",
    ].filter(Boolean);
    const text = box.txt ? ` "${box.txt}"` : "";
    const tail = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    return `${describeBox(box)} @ ${at} ${size}${tail}${text}`;
  });
}

/** One-line summary for the activity row / tool result */
export function summarizeLayout(report: RawLayoutReport, findings: LayoutFinding[]): string {
  const count = Array.isArray(report.elements) ? report.elements.length : 0;
  if (report.error) return `layout unavailable: ${report.error}`;
  if (findings.length === 0) return `${count} boxes mapped, no layout problems found`;
  return `${findings.length} layout problem(s) in ${count} box(es)`;
}
