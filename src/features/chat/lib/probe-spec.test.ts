// ============================================================
// Behaviour probes — regression tests
// ============================================================
// The compiled probe script normally only ever runs inside a browser
// frame, where a mistake in it is invisible until a user's app is being
// tested. So it is executed here too, against a small fake DOM, which is
// the only way a syntax error or a mis-wired assertion can be caught
// before it ships.

import { describe, expect, it, vi } from "vitest";
import {
  ProbeSpecError,
  buildProbeScript,
  formatProbeReport,
  interpretProbeReport,
  normalizeProbes,
  probeFailureDetails,
  probeSummaryLine,
  type ProbeReport,
  type ProbeSpec,
} from "./probe-spec";

// ── A tiny DOM, faithful only where the script touches it ────

class FakeElement {
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  attributes: Record<string, string> = {};
  events: string[] = [];
  clicks = 0;
  focusCalls = 0;
  form: FakeForm | null = null;
  private _value = "";

  constructor(tag: string, init: { id?: string; className?: string; text?: string; value?: string; attrs?: Record<string, string> } = {}) {
    this.tagName = tag.toUpperCase();
    if (init.id) this.id = init.id;
    if (init.className) this.className = init.className;
    if (init.text !== undefined) this.textContent = init.text;
    if (init.value !== undefined) this._value = init.value;
    if (init.attrs) this.attributes = init.attrs;
  }

  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = String(v);
  }

  click(): void {
    this.clicks += 1;
  }
  focus(): void {
    this.focusCalls += 1;
  }
  dispatchEvent(event: { type: string }): boolean {
    this.events.push(event.type);
    return true;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

class FakeForm {
  submitted = 0;
  requestSubmit(): void {
    this.submitted += 1;
  }
}

/**
 * Stands in for the frame's console. The probe script patches `error` on
 * the object it is handed, and its `eval` steps run in GLOBAL scope — so a
 * test that exercises console capture has to install this as the global
 * console, or the indirect eval would reach Node's instead.
 */
class FakeConsole {
  errors: string[] = [];
  other: string[] = [];
  error = (...args: unknown[]): void => {
    this.errors.push(args.map(String).join(" "));
  };
  log = (...args: unknown[]): void => {
    this.other.push(args.map(String).join(" "));
  };
  info = this.log;
  warn = this.log;
  debug = this.log;
}

class FakeDom {
  activeElement: FakeElement | null = null;
  private elements: FakeElement[];

  constructor(elements: FakeElement[]) {
    this.elements = elements;
    this.activeElement = elements[0] ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.includes("[")) throw new Error("invalid selector");
    return this.matches(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector.includes("[")) throw new Error("invalid selector");
    return this.matches(selector);
  }

  private matches(selector: string): FakeElement[] {
    if (selector.startsWith("#")) return this.elements.filter((e) => e.id === selector.slice(1));
    if (selector.startsWith(".")) return this.elements.filter((e) => e.className.split(/\s+/).includes(selector.slice(1)));
    return this.elements.filter((e) => e.tagName === selector.toUpperCase());
  }
}

class FakeEvent {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
}
class FakeKeyboardEvent extends FakeEvent {
  key: string;
  constructor(type: string, init: { key?: string } = {}) {
    super(type);
    this.key = init.key ?? "";
  }
}

/** Compiles and runs the probe script against fake globals. */
async function runScript(
  probes: ProbeSpec[],
  dom: FakeDom,
  con = new FakeConsole()
): Promise<ProbeReport> {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const fakeWindow = {
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    listeners,
  };
  const fn = new Function(
    "document",
    "window",
    "console",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Event",
    "KeyboardEvent",
    "setTimeout",
    `return ${buildProbeScript(probes)}`
  );
  const raw = await fn(
    dom,
    fakeWindow,
    con,
    FakeElement,
    class extends FakeElement {},
    FakeEvent,
    FakeKeyboardEvent,
    (cb: () => void, ms: number) => setTimeout(cb, Math.min(ms, 1))
  );
  return interpretProbeReport(JSON.stringify(raw));
}

describe("normalizeProbes", () => {
  it("accepts a well-formed probe", () => {
    const plan = normalizeProbes([
      { name: "counter", steps: [{ action: "click", selector: "#inc" }], expect: [{ assert: "text", selector: "#n", equals: "1" }] },
    ]);
    expect(plan.probes).toHaveLength(1);
    expect(plan.probes[0]?.steps).toHaveLength(1);
    expect(plan.notes).toEqual([]);
  });

  it("rejects an empty probe list", () => {
    expect(() => normalizeProbes([])).toThrow(ProbeSpecError);
    expect(() => normalizeProbes(undefined)).toThrow(/non-empty array/);
  });

  it("rejects a probe with no assertions — it could not fail", () => {
    expect(() => normalizeProbes([{ name: "x", expect: [] }])).toThrow(/proves nothing/);
  });

  it("rejects unknown step actions and assertions by name", () => {
    expect(() => normalizeProbes([{ name: "x", steps: [{ action: "hover", selector: "#a" }], expect: [{ assert: "exists", selector: "#b" }] }])).toThrow(
      /unknown step action "hover"/
    );
    expect(() =>
      normalizeProbes([{ name: "x", expect: [{ assert: "looks-nice", selector: "#b" }] }])
    ).toThrow(/unknown assertion "looks-nice"/);
  });

  it("rejects a text assertion with nothing to compare against", () => {
    expect(() => normalizeProbes([{ name: "x", expect: [{ assert: "text", selector: "#b" }] }])).toThrow(
      /needs "equals" or "contains"/
    );
  });

  it("refuses more probes than one call may run", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, expect: [{ assert: "exists", selector: "#a" }] }));
    expect(() => normalizeProbes(many)).toThrow(/max 8/);
  });

  it("clamps a long wait instead of failing", () => {
    const plan = normalizeProbes([{ name: "x", steps: [{ action: "wait", ms: 90_000 }], expect: [{ assert: "exists", selector: "#a" }] }]);
    expect(plan.notes[0]).toMatch(/capped at 1500ms/);
    expect(plan.probes[0]?.steps?.[0]).toEqual({ action: "wait", ms: 1500 });
  });

  it("names the offending probe in selector errors", () => {
    expect(() => normalizeProbes([{ name: "checkout", expect: [{ assert: "exists", selector: "" }] }])).toThrow(
      /probe 1: exists needs a non-empty "selector"/
    );
  });
});

describe("the compiled probe script", () => {
  it("passes a probe whose assertions hold, and reports the steps taken", async () => {
    const inc = new FakeElement("button", { id: "inc" });
    const label = new FakeElement("span", { id: "n", text: "1" });
    const report = await runScript(
      [{ name: "increments", steps: [{ action: "click", selector: "#inc" }], expect: [{ assert: "text", selector: "#n", equals: "1" }] }],
      new FakeDom([inc, label])
    );
    expect(report.parseError).toBeUndefined();
    expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(inc.clicks).toBe(1);
    expect(report.results[0]?.steps).toBe(1);
  });

  it("fails with the actual value when an assertion does not hold", async () => {
    const label = new FakeElement("span", { id: "n", text: "0" });
    const report = await runScript(
      [{ name: "increments", expect: [{ assert: "text", selector: "#n", equals: "1" }] }],
      new FakeDom([label])
    );
    expect(report.failed).toBe(1);
    expect(report.results[0]?.failures[0]).toContain('text of "#n" is "0" but expected "1"');
  });

  it("fails — never silently passes — when a selector matches nothing", async () => {
    const report = await runScript([{ name: "missing", expect: [{ assert: "exists", selector: "#nope" }] }], new FakeDom([]));
    expect(report.passed).toBe(0);
    expect(report.results[0]?.failures[0]).toContain("no element matching");
  });

  it("treats an invalid CSS selector as a failure, not a crash", async () => {
    const report = await runScript([{ name: "bad", expect: [{ assert: "exists", selector: "a[href" }] }], new FakeDom([]));
    expect(report.failed).toBe(1);
    expect(report.results[0]?.failures[0]).toContain("no element matching");
  });

  it("keeps running the other probes when one fails", async () => {
    const ok = new FakeElement("span", { id: "ok", text: "yes" });
    const report = await runScript(
      [
        { name: "broken", steps: [{ action: "click", selector: "#ghost" }], expect: [{ assert: "exists", selector: "#ok" }] },
        { name: "fine", expect: [{ assert: "text", selector: "#ok", contains: "es" }] },
      ],
      new FakeDom([ok])
    );
    expect(report.results.map((r) => r.ok)).toEqual([false, true]);
    expect(report.results[0]?.failures[0]).toContain("step: no element matching");
  });

  it("counts matches and reads attributes", async () => {
    const items = [1, 2, 3].map((i) => new FakeElement("li", { className: "row", text: `item ${i}` }));
    const toggle = new FakeElement("button", { id: "t", attrs: { "aria-pressed": "true" } });
    const report = await runScript(
      [
        {
          name: "list",
          expect: [
            { assert: "count", selector: "li", atLeast: 3 },
            { assert: "count", selector: "li", atMost: 2 },
            { assert: "attr", selector: "#t", name: "aria-pressed", equals: "true" },
          ],
        },
      ],
      new FakeDom([...items, toggle])
    );
    expect(report.failed).toBe(1);
    expect(report.results[0]?.failures).toEqual(["count of \"li\" is 3, expected at most 2"]);
  });

  it("types into an input through the native setter and submits the form", async () => {
    const input = new FakeElement("input", { id: "email" });
    const form = new FakeForm();
    input.form = form as unknown as FakeElement["form"];
    const report = await runScript(
      [
        {
          name: "submit",
          steps: [{ action: "type", selector: "#email", text: "a@b.co", submit: true }],
          expect: [{ assert: "value", selector: "#email", equals: "a@b.co" }],
        },
      ],
      new FakeDom([input])
    );
    expect(report.passed).toBe(1);
    expect(input.value).toBe("a@b.co");
    expect(form.submitted).toBe(1);
    expect(input.events).toContain("input");
  });

  it("captures console errors and fails a no-error assertion on them", async () => {
    const con = new FakeConsole();
    const element = new FakeElement("span", { id: "x", text: "hi" });
    const realConsole = globalThis.console;
    (globalThis as { console: unknown }).console = con;
    let report: ProbeReport;
    try {
      report = await runScript(
        [
          {
            name: "clean console",
            steps: [{ action: "eval", code: "console.error('boom')" }],
            expect: [{ assert: "no-error" }],
          },
        ],
        new FakeDom([element]),
        con
      );
    } finally {
      (globalThis as { console: unknown }).console = realConsole;
    }
    expect(report.consoleErrors[0]).toContain("boom");
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.failures[0]).toContain("errors during the run");
    // The run must not leave the app's console patched.
    expect(con.error).toBeTypeOf("function");
  });

  it("fails a probe whose expectation expression throws", async () => {
    const report = await runScript(
      [{ name: "eval fails", expect: [{ assert: "eval", code: "(() => { throw new Error('nope'); })()" }] }],
      new FakeDom([])
    );
    expect(report.results[0]?.failures[0]).toContain("assertion expression threw: nope");
  });

  it("presses a key on the focused element", async () => {
    const field = new FakeElement("input", { id: "q" });
    const dom = new FakeDom([field]);
    const report = await runScript(
      [{ name: "enter", steps: [{ action: "press", key: "Enter" }], expect: [{ assert: "exists", selector: "#q" }] }],
      dom
    );
    expect(report.passed).toBe(1);
    expect(field.events).toEqual(["keydown", "keyup"]);
  });
});

describe("interpretProbeReport", () => {
  it("flags a truncated report instead of guessing", () => {
    const report = interpretProbeReport('{"probes":[{"name":"a","ok":true…[truncated 900 chars]');
    expect(report.parseError).toMatch(/truncated/);
    expect(report.total).toBe(0);
  });

  it("flags a non-JSON answer", () => {
    expect(interpretProbeReport("undefined").parseError).toMatch(/did not return/);
  });

  it("flags an empty result set", () => {
    expect(interpretProbeReport(JSON.stringify({ probes: [] })).parseError).toMatch(/no results/);
  });

  it("accepts an object as well as a serialized string", () => {
    const report = interpretProbeReport({ probes: [{ name: "x", ok: true, failures: [], steps: 2 }], consoleErrors: [] });
    expect(report.passed).toBe(1);
  });

  it("treats a probe that reports ok but carries failures as failed", () => {
    const report = interpretProbeReport({ probes: [{ name: "x", ok: true, failures: ["nope"], steps: 1 }] });
    expect(report.failed).toBe(1);
  });
});

describe("report formatting", () => {
  const report: ProbeReport = {
    total: 2,
    passed: 1,
    failed: 1,
    results: [
      { name: "adds", ok: true, failures: [], steps: 2 },
      { name: "removes", ok: false, failures: ['count of "li" is 3, expected 2'], steps: 1 },
    ],
    consoleErrors: ["Warning: boom"],
  };

  it("summarises the tally", () => {
    expect(probeSummaryLine(report)).toBe("1/2 probes passed");
    expect(probeSummaryLine({ ...report, parseError: "x" })).toBe("probes: unreadable report");
  });

  it("quotes failures verbatim for the reviewer", () => {
    const lines = formatProbeReport(report);
    expect(lines[0]).toBe("PASS adds");
    expect(lines[1]).toContain("FAIL removes:");
    expect(lines[2]).toContain("Console errors seen during the run");
  });

  it("extracts failure details for the ledger", () => {
    expect(probeFailureDetails(report)).toEqual(['removes: count of "li" is 3, expected 2']);
  });
});

describe("script hygiene", () => {
  it("does not leak the DOM patch into the parent document", async () => {
    const con = new FakeConsole();
    const spy = vi.fn();
    con.error = spy;
    await runScript([{ name: "p", expect: [{ assert: "exists", selector: "#a" }] }], new FakeDom([]), con);
    // Restored to the original function object, not a wrapper.
    expect(con.error).toBe(spy);
  });
});
