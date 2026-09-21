// ============================================================
// Model State — Reasoning Effort & Capability Snapping
// ============================================================
// Replaces the retired InTab tier machinery with the thing it was
// emulating: OpenRouter's own per-request reasoning state.
//
// OpenRouter normalizes reasoning control across providers:
//
//   "reasoning": { "effort": "high" }        // max|xhigh|high|medium|low|minimal|none
//   "reasoning_effort": "high"               // OpenAI-style alias
//
// and every model advertises what it accepts in GET /api/v1/models:
//
//   supported_parameters: ["reasoning", "reasoning_effort", "tools", …]
//   reasoning: {
//     supported_efforts: ["high", "medium", "low"],   // descending
//     default_effort: "medium",
//     mandatory: true,
//   }
//
// The UI offers four rungs (low · medium · high · max). Each rung is
// a DESIRE, snapped here to the model's declared vocabulary — some
// models only accept e.g. ["xhigh","medium"], some accept nothing at
// all, and sending an unsupported key 400s the whole request.
//
// Everything is display-agnostic and side-effect free: the caller
// merges the returned fragment into the request body. UI-free so the
// session worker can import it too.

import { DEFAULT_REASONING_EFFORT } from "../constants";
import type { ModelInfo, ReasoningEffort } from "../types";

/** Rungs offered in the UI, cheapest first */
export const REASONING_EFFORT_LEVELS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "max",
];

export interface ReasoningEffortMeta {
  id: ReasoningEffort;
  /** Short trigger label */
  label: string;
  /** One-liner shown under the option */
  tagline: string;
}

export const REASONING_EFFORT_META: Record<ReasoningEffort, ReasoningEffortMeta> = {
  low: {
    id: "low",
    label: "Low",
    tagline: "Minimal thinking · fastest replies",
  },
  medium: {
    id: "medium",
    label: "Medium",
    tagline: "Balanced thinking · the default",
  },
  high: {
    id: "high",
    label: "High",
    tagline: "Deeper thinking for hard problems",
  },
  max: {
    id: "max",
    label: "Max",
    tagline: "Deepest thinking the model offers",
  },
};

/**
 * Canonical effort ordering (cheapest → deepest) used to measure how
 * far a desired rung sits from what a model actually accepts. Values
 * outside this list sort to the end (unknown → furthest).
 */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Efforts the `reasoning_effort` alias accepts (note: no "max") */
const REASONING_EFFORT_ALIAS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "none",
]);

function effortDistance(a: string, b: string): number {
  const ia = EFFORT_ORDER.indexOf(a);
  const ib = EFFORT_ORDER.indexOf(b);
  if (ia === -1 || ib === -1) return Number.POSITIVE_INFINITY;
  return Math.abs(ia - ib);
}

/** Clamps an effort to the model's declared list, or undefined */
function snapEffort(desired: string, supported: string[] | undefined): string | undefined {
  if (!supported || supported.length === 0) return desired;
  if (supported.includes(desired)) return desired;
  // Nearest declared level wins; ties go deeper (the rung's intent).
  return (
    [...supported].sort(
      (a, b) =>
        effortDistance(a, desired) - effortDistance(b, desired) ||
        EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a)
    )[0] ?? undefined
  );
}

/**
 * Whether a model may be handed tool definitions. The catalog's
 * `supported_parameters` is authoritative when present; a model that
 * declares none is allowed through — absence of metadata is not
 * evidence of incapability, and the curated fallback list carries none.
 */
export function modelSupportsTools(info: ModelInfo | undefined): boolean {
  const params = info?.supportedParameters;
  if (!params || params.length === 0) return true;
  return params.includes("tools");
}

/**
 * Whether the catalog says this model can reason at all. Unknown
 * metadata (catalog not loaded) is reported as `false` so the state
 * picker stays hidden rather than promising a control that would be
 * dropped on the wire.
 */
export function modelSupportsReasoning(info: ModelInfo | undefined): boolean {
  const params = info?.supportedParameters;
  if (!params || params.length === 0) return false;
  if (params.includes("reasoning") || params.includes("reasoning_effort")) {
    // A model that requires reasoning is always reasoning-capable.
    return true;
  }
  // Some catalog entries expose the reasoning block without listing
  // the parameter — trust whichever evidence exists.
  return Boolean(info?.reasoning);
}

/**
 * Rungs worth offering for a model: only those it can express. A
 * model with `supported_efforts` narrower than the UI's four rungs
 * collapses them (e.g. ["xhigh","medium"] → High and Max both map to
 * "medium"/"xhigh"), so duplicates are dropped in favor of the deeper
 * one. Empty when the model cannot reason.
 */
export function availableEfforts(info: ModelInfo | undefined): ReasoningEffort[] {
  if (!modelSupportsReasoning(info)) return [];
  const supported = info?.reasoning?.supportedEfforts;
  if (!supported || supported.length === 0) return [...REASONING_EFFORT_LEVELS];
  return REASONING_EFFORT_LEVELS.filter((rung) => snapEffort(rung, supported) !== undefined);
}

/**
 * The default rung for a model: its own `default_effort` when that
 * maps onto one of our four rungs, otherwise the app default (medium).
 */
export function defaultEffortFor(info: ModelInfo | undefined): ReasoningEffort {
  const declared = info?.reasoning?.defaultEffort?.toLowerCase();
  if (declared) {
    const direct = REASONING_EFFORT_LEVELS.find((r) => r === declared);
    if (direct) return direct;
    // Provider vocabulary differs (xhigh/minimal/none) — map to the
    // nearest rung we offer.
    if (declared === "xhigh" || declared === "max") return "max";
    if (declared === "minimal" || declared === "none") return "low";
  }
  return DEFAULT_REASONING_EFFORT;
}

/**
 * Builds the JSON body fragment for a chosen rung, snapped to what
 * the model declares. Returns `{}` when there is nothing safe to
 * send — no catalog data (offline / cold start), or a model without
 * reasoning support. Sending an unsupported reasoning key is a 400 on
 * strict providers, so omitting it (provider default) is the safe move.
 *
 * Preference order for the key:
 *  1. `reasoning.effort` — the modern map, and the only one that
 *     accepts "max".
 *  2. `reasoning_effort` — the alias, clamped to its accepted set.
 */
export function resolveEffortState(
  effort: ReasoningEffort | undefined,
  info: ModelInfo | undefined
): Record<string, unknown> {
  if (!effort) return {};
  const params = info?.supportedParameters;
  if (!params || params.length === 0) return {};
  if (!modelSupportsReasoning(info)) return {};

  const supported = info?.reasoning?.supportedEfforts;
  const snapped = snapEffort(effort, supported);
  if (!snapped) return {};
  const wireEffort = snapped === "none" ? undefined : snapped;

  const supportsReasoningMap = params.includes("reasoning");
  const supportsEffortAlias = params.includes("reasoning_effort");

  // "none" means reasoning off — only expressible through the map, and
  // never sent to a model that mandates reasoning.
  if (snapped === "none") {
    if (info?.reasoning?.mandatory) return {};
    return supportsReasoningMap ? { reasoning: { enabled: false } } : {};
  }

  if (supportsReasoningMap && wireEffort) {
    return { reasoning: { effort: wireEffort } };
  }

  if (supportsEffortAlias && wireEffort) {
    // The alias rejects "max" — clamp to the deepest it accepts, then
    // re-snap against the model's own list.
    const aliasEffort = REASONING_EFFORT_ALIAS.has(wireEffort) ? wireEffort : "xhigh";
    const finalEffort = snapEffort(aliasEffort, supported) ?? aliasEffort;
    if (finalEffort === "none") return {};
    return { reasoning_effort: finalEffort };
  }

  return {};
}

/** True when the turn's images can ride this model (unknown → allowed) */
export function modelSupportsVision(info: ModelInfo | undefined): boolean {
  if (!info?.inputModalities) return true;
  return info.inputModalities.includes("image");
}
