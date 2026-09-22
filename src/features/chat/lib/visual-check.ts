// ============================================================
// Visual Check — Screenshot → Vision Model → Text Evidence
// ============================================================
// This is the one observation channel a CLI agent structurally cannot
// have. `query_preview_dom` answers "is this text in the DOM" and
// `get_preview_layout` answers "where are the boxes", and neither can
// answer the question a user actually asks about a UI: does this look
// right? Colour that disappeared, text over a background of the same
// colour, a button rendered 4px tall, an image that failed to load with
// no alt text, a modal behind an overlay, an emoji-replaced icon font —
// all of it is invisible to a DOM diff and obvious in a picture.
//
// The transport constraint shapes the whole design: a TOOL RESULT IS
// TEXT, so the image cannot ride back into the main transcript as an
// image. Instead the picture is shown to a vision model whose ANSWER is
// the tool result, and the main model reads a claim it can act on.
//
// Two honesty rules, because a vision model is the most confident
// wrong-narrator available:
//
//   1. The capture is APPROXIMATE — it is a DOM→SVG→canvas raster, so web
//      fonts and cross-origin images do not load inside it. The vision
//      prompt says so, and so does the tool result, so a font difference
//      is never reported as a bug in the app.
//   2. The verdict is EVIDENCE, not proof. It is attributed to a model
//      and to the build it saw, and an "ok" is never presented as a test.
//
// Pure: capture and network live in the caller, so every parse and
// routing decision here is unit-testable without a browser or a key.

import { getCachedModelCatalog } from "./model-catalog";
import { UNTRUSTED_RULE } from "./untrusted";
import type { ModelInfo } from "../types";

/** Chars of a PNG data URL accepted from the preview frame (~1MB) */
export const SCREENSHOT_MAX_CHARS = 1_400_000;
/** Longest side of the capture the runtime is asked for */
export const SCREENSHOT_MAX_SIDE = 1280;
/** Chars of raw model output kept when the contract was not followed */
const RAW_FALLBACK_CHARS = 1_200;
/** Issues reported to the parent, at most */
const MAX_ISSUES = 6;
/** Chars per reported issue */
const ISSUE_MAX_CHARS = 300;

// ── Capture payload (crosses the iframe boundary) ────────────

export interface ScreenshotCapture {
  /** PNG data URL produced inside the preview frame */
  dataUrl: string;
  width: number;
  height: number;
  /** Selector the capture was scoped to (null = the whole viewport) */
  selector: string | null;
  /** True when the rasterizer could not load fonts/remote images */
  approximate: boolean;
}

/**
 * Validates the capture the preview frame posted back. The payload has
 * crossed an untrusted boundary: a bad shape, a non-image URL or an
 * oversized body is refused here rather than being handed to a model.
 */
export function normalizeScreenshot(raw: unknown): ScreenshotCapture | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { dataUrl?: unknown; width?: unknown; height?: unknown; selector?: unknown; approximate?: unknown };
  if (typeof r.dataUrl !== "string") return null;
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(r.dataUrl)) return null;
  if (r.dataUrl.length > SCREENSHOT_MAX_CHARS) return null;
  const width = typeof r.width === "number" && Number.isFinite(r.width) ? Math.round(r.width) : 0;
  const height = typeof r.height === "number" && Number.isFinite(r.height) ? Math.round(r.height) : 0;
  if (width <= 0 || height <= 0) return null;
  return {
    dataUrl: r.dataUrl,
    width,
    height,
    selector: typeof r.selector === "string" && r.selector ? r.selector : null,
    approximate: r.approximate !== false,
  };
}

/** One-line statement of what the capture can and cannot show */
export function captureCaveat(capture: ScreenshotCapture): string {
  return (
    `${capture.width}×${capture.height}px ` +
    (capture.selector ? `capture of \`${capture.selector}\`` : "viewport capture") +
    (capture.approximate
      ? "; rendering is layout-accurate but approximate — web fonts and remote images may be missing"
      : "")
  );
}

// ── Vision model routing ─────────────────────────────────────

export interface VisionModelChoice {
  modelId: string;
  reason: string;
}

/** Whether the catalog explicitly says this model accepts images */
function explicitlyVision(info: ModelInfo | undefined): boolean {
  return Boolean(info?.inputModalities?.includes("image"));
}

/**
 * Chooses which model looks at the picture. Preference order:
 *   1. the conversation's own model, when it is vision-capable — the
 *      user's choice is not overridden for a job it can do itself;
 *   2. the cheapest FREE vision-capable model the catalog reports;
 *   3. the cheapest vision-capable model at all.
 *
 * `null` when nothing in the catalog can see: the tool then reports that
 * a visual check is impossible rather than sending a PNG to a text model
 * (which would silently answer about code it cannot see).
 */
export function pickVisionModel(
  currentModel: string,
  /** Catalog override (tests); defaults to the live cached catalog */
  catalog: ModelInfo[] = getCachedModelCatalog() ?? []
): VisionModelChoice | null {
  const current = catalog.find((m) => m.id === currentModel);
  if (explicitlyVision(current)) {
    return { modelId: currentModel, reason: "your current model (vision-capable)" };
  }

  const vision = catalog.filter((m) => explicitlyVision(m) && m.id !== currentModel);
  const byPrice = (a: ModelInfo, b: ModelInfo) =>
    (a.completionPrice ?? Number.POSITIVE_INFINITY) -
      (b.completionPrice ?? Number.POSITIVE_INFINITY) ||
    (b.contextLength ?? 0) - (a.contextLength ?? 0) ||
    a.id.localeCompare(b.id);

  const free = vision.filter((m) => m.isFree).sort(byPrice)[0];
  if (free) return { modelId: free.id, reason: `free vision-capable model (${free.name})` };

  const paid = vision.filter((m) => typeof m.completionPrice === "number").sort(byPrice)[0];
  if (paid) return { modelId: paid.id, reason: `cheapest vision-capable model (${paid.name})` };

  return null;
}

// ── Prompt ───────────────────────────────────────────────────

export const VISUAL_CHECK_SYSTEM_PROMPT = [
  "You are inspecting a screenshot of a running web app on behalf of the coding agent that just changed it.",
  "You see rendered pixels only. You cannot see the source, so you must never claim what the code does.",
  "",
  "Answer in exactly this shape and nothing else:",
  "VERDICT: ok | problem | unclear",
  "ISSUES:",
  "- <one line per problem, naming the element and the defect you can see>",
  "",
  "Rules:",
  "- `ok` requires that you actually found what the question asks about, rendering correctly. Absence of an element is a problem, not an ok.",
  "- `unclear` when the image is blank, cut off, or the question cannot be answered from pixels. Say which.",
  "- The capture is a DOM rasterization: web fonts and remote images may be missing or substituted. Never report a font or an image-load difference as a defect.",
  "- Be specific about what you see and where (top-left, the second card, the header row). \"Looks fine\" is not an answer.",
  "- Judge only what the question asks about. Do not list unrelated opinions about the design.",
  "",
  UNTRUSTED_RULE,
].join("\n");

export interface VisualCheckPromptInput {
  /** What the caller wants to know */
  question: string;
  /** What the caller already believes the change did (audited against the image) */
  claim?: string;
  capture: ScreenshotCapture;
}

/** The user message that carries the picture and the question */
export function buildVisualCheckPrompt(input: VisualCheckPromptInput): string {
  const parts = [
    `What to check: ${input.question.trim()}`,
  ];
  if (input.claim?.trim()) {
    parts.push(
      "",
      "The agent's own claim about this change (verify or refute it from the image):",
      input.claim.trim()
    );
  }
  parts.push("", `Capture: ${captureCaveat(input.capture)}.`);
  return parts.join("\n");
}

// ── Verdict parsing ──────────────────────────────────────────

export type VisualVerdictCode = "ok" | "problem" | "unclear";

export interface VisualVerdict {
  verdict: VisualVerdictCode;
  /** Specific defects the vision model reported */
  issues: string[];
  /** Model output as received (bounded), for the transcript */
  raw: string;
  /** True when the answer did not follow the required contract */
  malformed: boolean;
}

/**
 * Parses the vision model's answer.
 *
 * A missing `VERDICT:` line is treated as `unclear` rather than guessed
 * at: a model that ignored the contract has not told us the UI is fine,
 * and quietly reading its prose as approval is exactly how an
 * unverified claim reaches a reviewer.
 */
export function parseVisualVerdict(raw: string): VisualVerdict {
  const text = (raw ?? "").trim();
  const bounded = text.length > RAW_FALLBACK_CHARS ? `${text.slice(0, RAW_FALLBACK_CHARS)}…` : text;

  const verdictLine = /^[^\S\n]*VERDICT[^\S\n]*:[^\S\n]*(ok|problem|unclear)\b/im.exec(text);
  const verdict = (verdictLine?.[1]?.toLowerCase() as VisualVerdictCode | undefined) ?? "unclear";

  const issues: string[] = [];
  const issuesAt = text.search(/^\s*ISSUES\s*:/im);
  if (issuesAt !== -1) {
    const body = text.slice(issuesAt).replace(/^\s*ISSUES\s*:/i, "");
    for (const line of body.split(/\r?\n/)) {
      const cleaned = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      if (!cleaned) continue;
      // A line that is only a follow-on label ("ISSUES:") is noise.
      if (/^ISSUES\s*:/i.test(cleaned)) continue;
      issues.push(cleaned.length > ISSUE_MAX_CHARS ? `${cleaned.slice(0, ISSUE_MAX_CHARS)}…` : cleaned);
      if (issues.length >= MAX_ISSUES) break;
    }
  }

  // A verdict of "problem" with no issue line is still a problem: carry the
  // model's own words so the caller is not left with a bare label.
  if (issues.length === 0 && verdict === "problem" && bounded) {
    issues.push(bounded.split(/\r?\n/).slice(-1)[0]!.trim().slice(0, ISSUE_MAX_CHARS));
  }

  return { verdict, issues, raw: bounded, malformed: !verdictLine };
}

/** True when the check actually established something about the UI */
export function visualCheckPassed(verdict: VisualVerdict): boolean {
  return verdict.verdict === "ok" && !verdict.malformed;
}

/** One-line attribution for the transcript / push gate */
export function visualCheckStatement(
  verdict: VisualVerdict,
  choice: VisionModelChoice,
  capture: ScreenshotCapture
): string {
  const what = verdict.verdict === "ok" ? "no visible problem" : verdict.verdict === "problem" ? `${verdict.issues.length} visible problem(s)` : "no verdict";
  return `Visual check by ${choice.modelId}: ${what} (${captureCaveat(capture)})`;
}
