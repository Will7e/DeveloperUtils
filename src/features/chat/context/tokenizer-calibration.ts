// ============================================================
// Token Calibration — Per-Model Estimator Correction
// ============================================================
// The char-per-token heuristic drifts per model family (GPT-style
// tokenizers run ~3.8–4 chars/token; Gemma/Llama differ). OpenRouter
// reports exact usage.promptTokens on every turn, so we learn a
// per-model correction ratio:
//
//     ratio = actual prompt tokens / estimated prompt tokens
//
// applied multiplicatively to future estimates for that model. An
// EWMA keeps the ratio stable across turns while still tracking
// drift, and a persisted store snapshot survives reloads.

/** Sample pairs recorded per model id, oldest first */
interface CalibrationSample {
  estimated: number;
  actual: number;
  at: number;
}

interface CalibrationState {
  samples: Record<string, CalibrationSample[]>;
}

const state: CalibrationState = { samples: {} };

/** EWMA weight of each new sample (higher = adapt faster, noisier) */
const EWMA_ALPHA = 0.35;
/** Keep the last N samples per model for debugging/reset */
const MAX_SAMPLES_PER_MODEL = 12;
/** Samples required before the correction ratio is trusted */
const MIN_SAMPLES = 2;
/** Clamp: a model that never drifts stays near 1.0; garbage frames can't explode it */
const MIN_RATIO = 0.5;
const MAX_RATIO = 2.0;

/**
 * Records one (estimated, actual) pair for a model and updates its
 * EWMA correction ratio. `estimated` must be the raw heuristic
 * estimate for the exact same payload OpenRouter counted.
 */
export function recordUsageCalibration(
  modelId: string,
  estimated: number,
  actual: number
): void {
  if (!modelId || !Number.isFinite(estimated) || !Number.isFinite(actual)) return;
  if (estimated <= 0 || actual <= 0) return;

  const list = (state.samples[modelId] ??= []);
  list.push({ estimated, actual, at: Date.now() });
  if (list.length > MAX_SAMPLES_PER_MODEL) list.shift();
}

/**
 * The learned chars/token correction ratio for a model (1.0 when
 * uncalibrated — i.e. fall through to the char-per-token heuristic).
 */
export function getCalibrationRatio(modelId: string | undefined): number {
  if (!modelId) return 1;
  const list = state.samples[modelId];
  if (!list || list.length < MIN_SAMPLES) return 1;

  // Latest ratio from the most recent sample
  const last = list[list.length - 1]!;
  const lastRatio = last.actual / last.estimated;

  // Running EWMA over all samples, newest weighted most
  let ewma = list[0]!.actual / list[0]!.estimated;
  for (let i = 1; i < list.length; i++) {
    const r = list[i]!.actual / list[i]!.estimated;
    ewma = EWMA_ALPHA * r + (1 - EWMA_ALPHA) * ewma;
  }

  // Trust the EWMA unless the newest sample disagrees wildly
  // (e.g. the user pasted a huge unusual payload) — then lean
  // toward the fresh observation.
  const ratio =
    Math.abs(lastRatio - ewma) / Math.max(0.1, ewma) > 0.5 ? (ewma + lastRatio) / 2 : ewma;

  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * True when a model has enough samples for its correction ratio to be
 * applied — i.e. the estimates shown for it have been checked against
 * real provider counts rather than being pure heuristic.
 */
export function isCalibrated(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (state.samples[modelId]?.length ?? 0) >= MIN_SAMPLES;
}

/** Clears learned calibration (settings reset / debugging) */
export function resetCalibration(): void {
  state.samples = {};
}

/** Snapshot for persistence rides the settings blob */
export interface CalibrationSnapshot {
  samples: Record<string, Array<{ estimated: number; actual: number; at: number }>>;
}

export function exportCalibration(): CalibrationSnapshot {
  return { samples: structuredClone(state.samples) };
}

export function importCalibration(snapshot: CalibrationSnapshot | undefined): void {
  if (!snapshot || typeof snapshot !== "object") return;
  state.samples = {};
  for (const [modelId, samples] of Object.entries(snapshot.samples ?? {})) {
    if (!Array.isArray(samples)) continue;
    state.samples[modelId] = samples
      .filter(
        (s): s is CalibrationSample =>
          s &&
          typeof s.estimated === "number" &&
          typeof s.actual === "number" &&
          typeof s.at === "number"
      )
      .slice(-MAX_SAMPLES_PER_MODEL);
  }
}
