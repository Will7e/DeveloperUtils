// ============================================================
// Behaviour Probes — assertions executed in the running preview
// ============================================================
// The agent can edit a file and read the rendered DOM, which proves an
// element exists but not that the app WORKS: that clicking increments,
// that submitting clears the form, that the list re-renders. Those are
// the claims every agent makes and nothing here could previously check.
//
// A probe is a small, declarative recipe — do these things, then assert
// these facts — compiled into one script that runs inside the preview
// frame. Two properties matter more than coverage:
//
//   * Determinism. The agent cannot smuggle free-form code into the run
//     path; steps and assertions are enumerated, capped and validated, so
//     a probe means the same thing every time it is executed.
//   * Honesty. A probe that cannot run (a CSS selector typo, an element
//     that never appears) FAILS with the reason attached. It never
//     silently passes, because a harness that reports success when it did
//     nothing is worse than no harness at all.

export class ProbeSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeSpecError";
  }
}

// ── Limits (this runs in the user's browser, on their tab) ───

export const MAX_PROBES = 8;
export const MAX_STEPS_PER_PROBE = 12;
export const MAX_EXPECTATIONS = 12;
export const MAX_SELECTOR_CHARS = 200;
export const MAX_CODE_CHARS = 600;
export const MAX_TEXT_CHARS = 400;
export const MAX_WAIT_MS = 1_500;
export const MAX_TOTAL_WAIT_MS = 6_000;

// ── Spec types ───────────────────────────────────────────────

export type ProbeStep =
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string; submit?: boolean }
  | { action: "press"; key: string; selector?: string }
  | { action: "wait"; ms: number }
  | { action: "eval"; code: string };

export type ProbeExpectation =
  | { assert: "exists"; selector: string }
  | { assert: "not-exists"; selector: string }
  | { assert: "text"; selector: string; equals?: string; contains?: string }
  | { assert: "count"; selector: string; equals?: number; atLeast?: number; atMost?: number }
  | { assert: "value"; selector: string; equals?: string; contains?: string }
  | { assert: "attr"; selector: string; name: string; equals?: string }
  | { assert: "eval"; code: string; equals?: unknown }
  | { assert: "no-error" };

export interface ProbeSpec {
  name: string;
  steps?: ProbeStep[];
  expect: ProbeExpectation[];
}

export interface ProbePlan {
  probes: ProbeSpec[];
  /** Adjustments worth telling the model about (clamped waits, etc.) */
  notes: string[];
}

// ── Interpretation types ─────────────────────────────────────

export interface ProbeResult {
  name: string;
  ok: boolean;
  failures: string[];
  steps: number;
}

export interface ProbeReport {
  total: number;
  passed: number;
  failed: number;
  results: ProbeResult[];
  consoleErrors: string[];
  /** Set when the frame's answer could not be used at all */
  parseError?: string;
}

// ── Validation ───────────────────────────────────────────────

function asRecord(value: unknown, what: string, index: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProbeSpecError(`probe ${index + 1} (${what}): expected an object.`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function selector(value: unknown, what: string, index: number): string {
  const raw = str(value);
  if (!raw) throw new ProbeSpecError(`probe ${index + 1}: ${what} needs a non-empty "selector".`);
  if (raw.length > MAX_SELECTOR_CHARS) {
    throw new ProbeSpecError(
      `probe ${index + 1}: the ${what} selector is ${raw.length} characters (max ${MAX_SELECTOR_CHARS}). Use a shorter, more specific selector.`
    );
  }
  return raw.trim();
}

function code(value: unknown, what: string, index: number): string {
  const raw = str(value);
  if (!raw) throw new ProbeSpecError(`probe ${index + 1}: ${what} needs a non-empty "code" expression.`);
  if (raw.length > MAX_CODE_CHARS) {
    throw new ProbeSpecError(
      `probe ${index + 1}: the ${what} expression is ${raw.length} characters (max ${MAX_CODE_CHARS}). Keep it a short expression that returns a value.`
    );
  }
  return raw;
}

function text(value: unknown, what: string, index: number): string {
  const raw = typeof value === "string" ? value : null;
  if (raw === null) throw new ProbeSpecError(`probe ${index + 1}: ${what} needs a "text" string.`);
  if (raw.length > MAX_TEXT_CHARS) {
    throw new ProbeSpecError(`probe ${index + 1}: ${what} text is longer than ${MAX_TEXT_CHARS} characters.`);
  }
  return raw;
}

function normalizeStep(raw: unknown, index: number, probe: string): ProbeStep {
  const step = asRecord(raw, `${probe} step`, index);
  const action = str(step.action);
  switch (action) {
    case "click":
      return { action: "click", selector: selector(step.selector, "click", index) };
    case "type": {
      const out: ProbeStep = {
        action: "type",
        selector: selector(step.selector, "type", index),
        text: text(step.text, "type", index),
      };
      if (step.submit === true) out.submit = true;
      return out;
    }
    case "press": {
      const key = str(step.key);
      if (!key) throw new ProbeSpecError(`probe ${index + 1}: a "press" step needs a "key" (e.g. "Enter").`);
      const out: ProbeStep = { action: "press", key: key.slice(0, 20) };
      if (step.selector !== undefined) out.selector = selector(step.selector, "press", index);
      return out;
    }
    case "wait": {
      const ms = typeof step.ms === "number" && Number.isFinite(step.ms) ? Math.floor(step.ms) : 50;
      return { action: "wait", ms: Math.min(Math.max(0, ms), MAX_WAIT_MS) };
    }
    case "eval":
      return { action: "eval", code: code(step.code, "eval step", index) };
    default:
      throw new ProbeSpecError(
        `probe ${index + 1}: unknown step action ${action ? `"${action}"` : "(missing)"}. Use click, type, press, wait or eval.`
      );
  }
}

function optionalString(value: unknown, what: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, what, index);
}

function optionalNumber(value: unknown, what: string, index: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProbeSpecError(`probe ${index + 1}: ${what} must be a finite number.`);
  }
  return value;
}

function normalizeExpectation(raw: unknown, index: number, probe: string): ProbeExpectation {
  const e = asRecord(raw, `${probe} expectation`, index);
  const assert = str(e.assert);
  switch (assert) {
    case "exists":
      return { assert: "exists", selector: selector(e.selector, "exists", index) };
    case "not-exists":
      return { assert: "not-exists", selector: selector(e.selector, "not-exists", index) };
    case "text": {
      const sel = selector(e.selector, "text", index);
      const equals = optionalString(e.equals, "text equals", index);
      const contains = optionalString(e.contains, "text contains", index);
      if (equals === undefined && contains === undefined) {
        throw new ProbeSpecError(
          `probe ${index + 1}: a "text" expectation needs "equals" or "contains", otherwise it cannot fail.`
        );
      }
      return { assert: "text", selector: sel, ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}) };
    }
    case "count": {
      const sel = selector(e.selector, "count", index);
      const equals = optionalNumber(e.equals, "count equals", index);
      const atLeast = optionalNumber(e.atLeast, "count atLeast", index);
      const atMost = optionalNumber(e.atMost, "count atMost", index);
      if (equals === undefined && atLeast === undefined && atMost === undefined) {
        throw new ProbeSpecError(
          `probe ${index + 1}: a "count" expectation needs "equals", "atLeast" or "atMost".`
        );
      }
      return {
        assert: "count",
        selector: sel,
        ...(equals !== undefined ? { equals } : {}),
        ...(atLeast !== undefined ? { atLeast } : {}),
        ...(atMost !== undefined ? { atMost } : {}),
      };
    }
    case "value": {
      const sel = selector(e.selector, "value", index);
      const equals = optionalString(e.equals, "value equals", index);
      const contains = optionalString(e.contains, "value contains", index);
      if (equals === undefined && contains === undefined) {
        throw new ProbeSpecError(`probe ${index + 1}: a "value" expectation needs "equals" or "contains".`);
      }
      return { assert: "value", selector: sel, ...(equals !== undefined ? { equals } : {}), ...(contains !== undefined ? { contains } : {}) };
    }
    case "attr": {
      const name = str(e.name);
      if (!name) throw new ProbeSpecError(`probe ${index + 1}: an "attr" expectation needs a "name".`);
      return {
        assert: "attr",
        selector: selector(e.selector, "attr", index),
        name: name.slice(0, 60),
        ...(e.equals !== undefined ? { equals: text(e.equals, "attr equals", index) } : {}),
      };
    }
    case "eval":
      return { assert: "eval", code: code(e.code, "eval expectation", index), ...(e.equals !== undefined ? { equals: e.equals } : {}) };
    case "no-error":
      return { assert: "no-error" };
    default:
      throw new ProbeSpecError(
        `probe ${index + 1}: unknown assertion ${assert ? `"${assert}"` : "(missing)"}. Use exists, not-exists, text, count, value, attr, eval or no-error.`
      );
  }
}

export function normalizeProbes(raw: unknown): ProbePlan {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProbeSpecError(
      'Provide "probes": a non-empty array of { name, steps: [...], expect: [...] } objects.'
    );
  }
  if (raw.length > MAX_PROBES) {
    throw new ProbeSpecError(
      `${raw.length} probes provided (max ${MAX_PROBES} per call). Split them across calls — each call is a separate piece of evidence.`
    );
  }

  const notes: string[] = [];
  let totalWait = 0;
  const probes = raw.map((entry, i) => {
    const probe = asRecord(entry, "probe", i);
    const name = str(probe.name) ?? `probe ${i + 1}`;
    const stepsRaw = probe.steps === undefined ? [] : probe.steps;
    if (!Array.isArray(stepsRaw)) throw new ProbeSpecError(`probe ${i + 1}: "steps" must be an array.`);
    if (stepsRaw.length > MAX_STEPS_PER_PROBE) {
      throw new ProbeSpecError(
        `probe ${i + 1}: ${stepsRaw.length} steps (max ${MAX_STEPS_PER_PROBE}). Split the flow into shorter probes.`
      );
    }
    const expectRaw = probe.expect;
    if (!Array.isArray(expectRaw) || expectRaw.length === 0) {
      throw new ProbeSpecError(
        `probe ${i + 1} ("${name}"): needs a non-empty "expect" array — a probe with no assertions cannot fail and therefore proves nothing.`
      );
    }
    if (expectRaw.length > MAX_EXPECTATIONS) {
      throw new ProbeSpecError(`probe ${i + 1}: ${expectRaw.length} expectations (max ${MAX_EXPECTATIONS}).`);
    }

    const steps = stepsRaw.map((rawStep) => {
      const step = normalizeStep(rawStep, i, name);
      if (step.action !== "wait") return step;
      totalWait += step.ms;
      // A clamped wait changes what the probe means: the model asked to
      // wait longer than the harness will sit still, so it has to be told
      // rather than left believing the app was given that time.
      const requested = (rawStep as { ms?: unknown })?.ms;
      if (typeof requested === "number" && requested > MAX_WAIT_MS) {
        notes.push(
          `probe ${i + 1}: a ${Math.floor(requested)}ms wait was capped at ${MAX_WAIT_MS}ms. Assert on a state that already exists, or re-run the probe later instead of waiting longer.`
        );
      }
      return step;
    });
    return {
      name: name.slice(0, 120),
      steps,
      expect: expectRaw.map((e) => normalizeExpectation(e, i, name)),
    };
  });

  if (totalWait > MAX_TOTAL_WAIT_MS) {
    notes.push(
      `Waiting ${totalWait}ms in total exceeds the ${MAX_TOTAL_WAIT_MS}ms budget; waits are capped per step at ${MAX_WAIT_MS}ms and the run may time out. Prefer asserting on a state that already exists, or re-run.`
    );
  }

  return { probes, notes };
}

// ── Compilation ──────────────────────────────────────────────

/**
 * Builds the expression the preview frame evaluates. It is ONE async
 * IIFE returning a plain object, so the frame's existing run_js channel
 * carries it with no new message kinds. Every failure is caught per
 * probe: one broken selector must not hide the results of the others.
 */
export function buildProbeScript(probes: readonly ProbeSpec[]): string {
  const plan = JSON.stringify(probes);
  return (
    "(async () => {" +
    "\n  const PLAN = " + plan + ";" +
    "\n  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));" +
    "\n  const errs = [];" +
    "\n  const push = (e) => { if (errs.length < 25) errs.push(String(e).slice(0, 300)); };" +
    "\n  const origError = console.error;" +
    "\n  console.error = (...a) => { push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ')); origError.apply(console, a); };" +
    "\n  const onError = (ev) => push((ev && (ev.message || ev.error)) || 'window error');" +
    "\n  window.addEventListener('error', onError);" +
    "\n  const q = (sel) => { try { return document.querySelector(sel); } catch { return null; } };" +
    "\n  const qa = (sel) => { try { return document.querySelectorAll(sel); } catch { return []; } };" +
    "\n  const flat = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();" +
    "\n  const textOf = (el) => (el ? flat(el.textContent) : null);" +
    "\n  const brief = (v) => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.slice(0, 160); } catch { return String(v); } };" +
    "\n  const setValue = (el, v) => {" +
    "\n    const Ctor = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;" +
    "\n    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'value');" +
    "\n    if (desc && desc.set) desc.set.call(el, v); else el.value = v;" +
    // React ignores a changed .value that never fired an event: the native
    // setter plus input/change is what a real keystroke looks like to it.
    "\n    el.dispatchEvent(new Event('input', { bubbles: true }));" +
    "\n    el.dispatchEvent(new Event('change', { bubbles: true }));" +
    "\n  };" +
    "\n  const check = async (a) => {" +
    "\n    const out = [];" +
    "\n    if (a.assert === 'no-error') { if (errs.length) out.push('console/window errors during the run: ' + errs.slice(0, 3).join(' | ')); return out; }" +
    "\n    if (a.assert === 'eval') {" +
    "\n      let v; try { v = await (0, eval)(a.code); } catch (e) { out.push('assertion expression threw: ' + ((e && e.message) || String(e))); return out; }" +
    "\n      if ('equals' in a) { if (JSON.stringify(v) !== JSON.stringify(a.equals)) out.push('expression returned ' + brief(v) + ' but expected ' + brief(a.equals)); }" +
    "\n      else if (!v) out.push('expression returned a falsy value: ' + brief(v));" +
    "\n      return out;" +
    "\n    }" +
    "\n    const el = q(a.selector);" +
    "\n    if (a.assert === 'exists') { if (!el) out.push('no element matching ' + brief(a.selector)); return out; }" +
    "\n    if (a.assert === 'not-exists') { if (el) out.push('element ' + brief(a.selector) + ' is still present'); return out; }" +
    "\n    if (!el) { out.push('no element matching ' + brief(a.selector)); return out; }" +
    "\n    if (a.assert === 'text') {" +
    "\n      const actual = textOf(el);" +
    "\n      if ('equals' in a && actual !== a.equals) out.push('text of ' + brief(a.selector) + ' is ' + brief(actual) + ' but expected ' + brief(a.equals));" +
    "\n      if ('contains' in a && !(actual || '').includes(a.contains)) out.push('text of ' + brief(a.selector) + ' does not contain ' + brief(a.contains) + ' (actual: ' + brief(actual) + ')');" +
    "\n      return out;" +
    "\n    }" +
    "\n    if (a.assert === 'count') {" +
    "\n      const n = qa(a.selector).length;" +
    "\n      if ('equals' in a && n !== a.equals) out.push('count of ' + brief(a.selector) + ' is ' + n + ' but expected ' + a.equals);" +
    "\n      if ('atLeast' in a && n < a.atLeast) out.push('count of ' + brief(a.selector) + ' is ' + n + ', expected at least ' + a.atLeast);" +
    "\n      if ('atMost' in a && n > a.atMost) out.push('count of ' + brief(a.selector) + ' is ' + n + ', expected at most ' + a.atMost);" +
    "\n      return out;" +
    "\n    }" +
    "\n    if (a.assert === 'value') {" +
    "\n      const actual = String(el.value == null ? '' : el.value);" +
    "\n      if ('equals' in a && actual !== a.equals) out.push('value of ' + brief(a.selector) + ' is ' + brief(actual) + ' but expected ' + brief(a.equals));" +
    "\n      if ('contains' in a && !actual.includes(a.contains)) out.push('value of ' + brief(a.selector) + ' does not contain ' + brief(a.contains) + ' (actual: ' + brief(actual) + ')');" +
    "\n      return out;" +
    "\n    }" +
    "\n    if (a.assert === 'attr') {" +
    "\n      const actual = el.getAttribute(a.name);" +
    "\n      if ('equals' in a ? actual !== a.equals : actual == null) out.push('attribute ' + brief(a.name) + ' of ' + brief(a.selector) + ' is ' + brief(actual));" +
    "\n      return out;" +
    "\n    }" +
    "\n    out.push('unsupported assertion: ' + brief(a.assert));" +
    "\n    return out;" +
    "\n  };" +
    "\n  const results = [];" +
    "\n  for (const probe of PLAN) {" +
    "\n    const failures = [];" +
    "\n    let steps = 0;" +
    "\n    try {" +
    "\n      for (const step of probe.steps || []) {" +
    "\n        if (step.action === 'click') {" +
    "\n          const el = q(step.selector);" +
    "\n          if (!el) { failures.push('step: no element matching ' + brief(step.selector)); break; }" +
    "\n          el.click();" +
    "\n        } else if (step.action === 'type') {" +
    "\n          const el = q(step.selector);" +
    "\n          if (!el) { failures.push('step: no element matching ' + brief(step.selector)); break; }" +
    "\n          if (typeof el.focus === 'function') el.focus();" +
    "\n          setValue(el, step.text);" +
    "\n          if (step.submit) {" +
    // requestSubmit runs the form's own submit path (React onSubmit included);
    // a synthetic keydown would only be seen by key handlers, not the form.
    "\n            if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();" +
    "\n            else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" +
    "\n          }" +
    "\n        } else if (step.action === 'press') {" +
    "\n          const el = step.selector ? q(step.selector) : document.activeElement;" +
    "\n          if (!el) { failures.push('step: nothing focused to press ' + brief(step.key) + ' on'); break; }" +
    "\n          el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));" +
    "\n          el.dispatchEvent(new KeyboardEvent('keyup', { key: step.key, bubbles: true }));" +
    "\n        } else if (step.action === 'wait') {" +
    "\n          await sleep(Math.min(step.ms, 1500));" +
    "\n        } else if (step.action === 'eval') {" +
    "\n          await (0, eval)(step.code);" +
    "\n        }" +
    "\n        steps++;" +
    "\n        await sleep(20);" +
    "\n      }" +
    "\n      for (const a of probe.expect) { const f = await check(a); for (const line of f) failures.push(line); }" +
    "\n    } catch (e) {" +
    "\n      failures.push('probe threw: ' + ((e && e.message) || String(e)));" +
    "\n    }" +
    "\n    results.push({ name: probe.name, ok: failures.length === 0, failures: failures, steps: steps });" +
    "\n  }" +
    "\n  console.error = origError;" +
    "\n  window.removeEventListener('error', onError);" +
    "\n  return { probes: results, consoleErrors: errs };" +
    "\n})()"
  );
}

// ── Interpretation ───────────────────────────────────────────

function coerceResult(raw: unknown, index: number): ProbeResult {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const failures = Array.isArray(r.failures) ? r.failures.map((f) => String(f).slice(0, 300)) : [];
  return {
    name: typeof r.name === "string" && r.name ? r.name : `probe ${index + 1}`,
    ok: r.ok === true && failures.length === 0,
    failures,
    steps: typeof r.steps === "number" && Number.isFinite(r.steps) ? r.steps : 0,
  };
}

/**
 * Turns the frame's answer into a report. The frame serializes to a JSON
 * STRING and truncates at 8k, so both a string and an object are accepted,
 * and an unusable answer becomes parseError — never a silent pass.
 */
export function interpretProbeReport(result: unknown): ProbeReport {
  const empty: ProbeReport = { total: 0, passed: 0, failed: 0, results: [], consoleErrors: [] };
  let parsed: unknown = result;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    const truncation = trimmed.match(/…\[truncated \d+ chars\]$/);
    if (truncation) {
      return {
        ...empty,
        parseError:
          "The preview truncated the probe report, so its results cannot be trusted. Run fewer probes per call (or fewer expectations), then retry.",
      };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        ...empty,
        parseError: `The preview did not return a probe report (got ${trimmed.slice(0, 120) || "an empty answer"}).`,
      };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...empty, parseError: "The preview returned no probe report." };
  }

  const raw = parsed as { probes?: unknown; consoleErrors?: unknown };
  const list = Array.isArray(raw.probes) ? raw.probes : [];
  if (list.length === 0) {
    return { ...empty, parseError: "The probe script produced no results — the preview may have reloaded mid-run." };
  }
  const results = list.map(coerceResult);
  const consoleErrors = Array.isArray(raw.consoleErrors)
    ? raw.consoleErrors.map((e) => String(e).slice(0, 300)).slice(0, 10)
    : [];
  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, failed: results.length - passed, results, consoleErrors };
}

/** One-line tally, e.g. "3/4 probes passed" */
export function probeSummaryLine(report: ProbeReport): string {
  if (report.parseError) return "probes: unreadable report";
  if (report.total === 0) return "probes: nothing ran";
  return `${report.passed}/${report.total} probes passed`;
}

/**
 * The reviewer-facing detail lines. Failures come first and are quoted
 * verbatim: they are the only part of a probe run that changes anyone's
 * behaviour.
 */
export function formatProbeReport(report: ProbeReport): string[] {
  if (report.parseError) return [report.parseError];
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.ok) lines.push(`PASS ${r.name}`);
    else lines.push(`FAIL ${r.name}: ${r.failures.join(" | ") || "no reason reported"}`);
  }
  if (report.consoleErrors.length > 0) {
    lines.push(`Console errors seen during the run: ${report.consoleErrors.slice(0, 3).join(" | ")}`);
  }
  return lines;
}

/** Failure lines only, capped — what the ledger stores as details. */
export function probeFailureDetails(report: ProbeReport): string[] {
  return report.results
    .filter((r) => !r.ok)
    .slice(0, 8)
    .map((r) => `${r.name}: ${r.failures.join(" | ") || "no reason reported"}`);
}
