// ============================================================
// Preview Layout — Analysis Tests
// ============================================================
// Precision matters more than recall here: the agent acts on whatever
// this reports, so a rule that fires on healthy layout is worse than a
// rule that misses a real bug.

import { describe, it, expect } from "vitest";
import {
  analyzeLayout,
  describeBox,
  formatLayoutMap,
  normalizeLayoutReport,
  summarizeLayout,
  type RawBox,
  type RawLayoutReport,
} from "./preview-layout";

function box(over: Partial<RawBox> = {}): RawBox {
  return { tag: "div", x: 0, y: 0, w: 100, h: 100, ...over };
}

function report(over: Partial<RawLayoutReport> = {}): RawLayoutReport {
  return {
    viewport: { w: 1280, h: 800 },
    document: { w: 1280, h: 2000 },
    elements: [],
    ...over,
  };
}

describe("normalizeLayoutReport", () => {
  it("returns an empty report for junk", () => {
    expect(normalizeLayoutReport(null).elements).toEqual([]);
    expect(normalizeLayoutReport("nope").viewport).toEqual({ w: 0, h: 0 });
  });

  it("coerces numbers and drops junk elements", () => {
    const normalized = normalizeLayoutReport({
      viewport: { w: 800, h: "tall" },
      document: { w: 900, h: 100 },
      elements: [null, { tag: "div", x: "1", y: 2, w: 3, h: 4 }, { w: 1 }],
    });
    expect(normalized.viewport).toEqual({ w: 800, h: 0 });
    expect(normalized.elements).toHaveLength(2);
    expect(normalized.elements[1]!.tag).toBe("?");
  });

  it("drops overflow values that are not really overflow", () => {
    const normalized = normalizeLayoutReport({ elements: [{ tag: "div", ow: 0, oh: 1 }] });
    expect(normalized.elements[0]!.ow).toBeUndefined();
    expect(normalized.elements[0]!.oh).toBeUndefined();
  });

  it("caps long text", () => {
    const normalized = normalizeLayoutReport({ elements: [{ tag: "p", txt: "x".repeat(200) }] });
    expect(normalized.elements[0]!.txt).toHaveLength(60);
  });
});

describe("describeBox", () => {
  it("renders tag, id and the first class only", () => {
    expect(describeBox(box({ tag: "ul", id: "menu", cls: "list dense" }))).toBe("ul#menu.list");
    expect(describeBox(box({ tag: "span" }))).toBe("span");
  });
});

describe("analyzeLayout", () => {
  it("stays silent on healthy layout", () => {
    expect(
      analyzeLayout(
        report({ elements: [box({ tag: "main", w: 1280, h: 600 }), box({ tag: "p", y: 20, h: 40 })] })
      )
    ).toEqual([]);
  });

  it("reports horizontal page scroll with the exact overflow", () => {
    const findings = analyzeLayout(report({ document: { w: 1320, h: 2000 } }));
    expect(findings[0]!.code).toBe("horizontal-page-scroll");
    expect(findings[0]!.message).toContain("40px");
  });

  it("reports a collapsed visible element", () => {
    const findings = analyzeLayout(report({ elements: [box({ tag: "div", id: "app", w: 0, h: 0 })] }));
    expect(findings[0]!.code).toBe("collapsed-element");
    expect(findings[0]!.message).toContain("div#app");
  });

  it("reports clipped content on either axis", () => {
    const findings = analyzeLayout(
      report({ elements: [box({ tag: "section", ow: 30 }), box({ tag: "aside", y: 200, oh: 55 })] })
    );
    expect(findings.map((f) => f.code)).toEqual(["clipped-content", "clipped-content"]);
    expect(findings[0]!.message).toContain("30px horizontally");
    expect(findings[1]!.message).toContain("55px vertically");
  });

  it("reports an element pushed off-screen", () => {
    const findings = analyzeLayout(report({ elements: [box({ tag: "div", x: 2000, y: 10 })] }));
    expect(findings[0]!.code).toBe("offscreen-element");
    expect(findings[0]!.message).toContain("1280×800");
  });

  it("reports an element wider than the viewport", () => {
    const findings = analyzeLayout(report({ elements: [box({ tag: "table", w: 1600, h: 50 })] }));
    expect(findings[0]!.code).toBe("wider-than-viewport");
  });

  it("ignores zero-size boxes that are also irrelevant to the viewport rules", () => {
    // A collapsed box reports collapsed, and NOT off-screen as well: one
    // finding per problem keeps the report actionable.
    const findings = analyzeLayout(report({ elements: [box({ w: 0, h: 0, y: 5000 })] }));
    expect(findings.map((f) => f.code)).toEqual(["collapsed-element"]);
  });

  it("caps the report", () => {
    const many = Array.from({ length: 40 }, (_, i) => box({ tag: `div`, id: `e${i}`, w: 0, h: 0 }));
    expect(analyzeLayout(report({ elements: many })).length).toBe(12);
  });

  it("tolerates a report with no elements", () => {
    expect(analyzeLayout(report())).toEqual([]);
  });
});

describe("formatLayoutMap", () => {
  it("renders position, size, flags and text", () => {
    const rows = formatLayoutMap(
      report({ elements: [box({ tag: "h1", x: 8, y: 16, w: 200, h: 40, txt: "Hello" })] })
    );
    expect(rows[0]).toBe('h1 @ 8,16 200×40 "Hello"');
  });

  it("marks overflow and collapsed boxes", () => {
    const rows = formatLayoutMap(
      report({ elements: [box({ tag: "div", ow: 12 }), box({ tag: "div", id: "c", w: 0, h: 0 })] })
    );
    expect(rows[0]).toContain("[overflow-x 12px]");
    expect(rows[1]).toContain("[collapsed]");
  });

  it("respects the row cap", () => {
    const many = Array.from({ length: 10 }, () => box());
    expect(formatLayoutMap(report({ elements: many }), 3)).toHaveLength(3);
  });
});

describe("summarizeLayout", () => {
  it("summarizes a clean map", () => {
    expect(summarizeLayout(report({ elements: [box()] }), [])).toBe(
      "1 boxes mapped, no layout problems found"
    );
  });

  it("counts the problems", () => {
    const r = report({ elements: [box({ w: 0, h: 0 })] });
    expect(summarizeLayout(r, analyzeLayout(r))).toMatch(/1 layout problem/);
  });

  it("surfaces a collector error", () => {
    expect(summarizeLayout(report({ error: "no preview" }), [])).toBe(
      "layout unavailable: no preview"
    );
  });
});
