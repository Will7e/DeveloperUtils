// ============================================================
// Argument Coercion — Parse The Call The Model Meant
// ============================================================
// tool-repair.ts repairs a whole arguments payload: fences, embedded JSON,
// trailing commas, Python literals, truncation. It cannot help with the
// failure that actually shows up most often, because the payload is perfectly
// valid JSON and the mistake is one level down:
//
//     { "method": "POST", "url": "...", "headers": "{\"Accept\":\"application/json\"}" }
//
// `headers` is declared an object, the model sent a string that CONTAINS an
// object, and validateAgainstSchema answers with a precise error
// (`must be of type object, got string`) that a weak model reads and repeats.
// The intent is unambiguous, so refusing it is a harness failure, not a model
// failure — this module parses what was meant and says that it did.
//
// Three rules keep this conservative rather than clever:
//
//   • The schema decides. A field declared `string` is NEVER coerced, which is
//     what protects `content`, `oldString`, `code`, `body` and `facts` — text
//     that legitimately looks like JSON must stay text.
//   • A repair is REPORTED, never silent (the same rule tool-repair.ts
//     follows), so the activity row can say the arguments were repaired.
//   • A value that cannot be repaired is left EXACTLY as it was, so the schema
//     validator produces its precise error instead of this module inventing a
//     vague one.
//
// Pure and side-effect free: a schema plus parsed arguments in, arguments plus
// notes out.

import type { ArgSchema } from "./tool-registry";

export interface CoercionOutcome {
  args: Record<string, unknown>;
  /** Human-readable notes, one per repair, for the activity row and the log */
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a string that is supposed to hold JSON.
 *
 * Tolerates the two shapes models actually produce inside a string: a trailing
 * comma before a closer, and surrounding whitespace. Returns undefined rather
 * than throwing, so the caller can leave the original value untouched.
 */
function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    /* try the tolerant pass below */
  }
  try {
    return JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Coerces one value to what its schema declares, recursively.
 *
 * Every conversion is reported in `notes`. A value with nothing to convert is
 * returned unchanged (same reference), so a caller can tell a repair from a
 * pass-through by comparing.
 */
function coerceValue(
  label: string,
  value: unknown,
  schema: ArgSchema,
  notes: string[]
): unknown {
  // ── object declared, string sent ──
  if (schema.type === "object" && typeof value === "string") {
    const parsed = parseLooseJson(value);
    if (isRecord(parsed)) {
      notes.push(`${label} was sent as a JSON string and read as an object`);
      return coerceValue(label, parsed, schema, notes);
    }
    // An empty string is how a model says "no headers, no options" — and an
    // empty object is what it means.
    if (value.trim() === "") return {};
    return value;
  }

  // ── array declared, string sent ──
  if (schema.type === "array" && typeof value === "string") {
    const parsed = parseLooseJson(value);
    if (Array.isArray(parsed)) {
      notes.push(`${label} was sent as a JSON string and read as an array`);
      return coerceValue(label, parsed, schema, notes);
    }
    return value;
  }

  // ── number declared, numeric string sent ──
  if (schema.type === "number" && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        notes.push(`${label} was sent as a string and read as a number`);
        return numeric;
      }
    }
    return value;
  }

  // ── boolean declared, "true"/"false" sent ──
  if (schema.type === "boolean" && typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") {
      notes.push(`${label} was sent as a string and read as true`);
      return true;
    }
    if (trimmed === "false") {
      notes.push(`${label} was sent as a string and read as false`);
      return false;
    }
    return value;
  }

  // ── enum: accept a case/whitespace variant, send back the canonical value ──
  if (schema.enum && typeof value === "string") {
    const exact = schema.enum.find((e) => e === value);
    if (exact) return value;
    const loose = schema.enum.find((e) => e.toLowerCase() === value.trim().toLowerCase());
    if (loose) {
      notes.push(`${label} matched its allowed value "${loose}" case-insensitively`);
      return loose;
    }
    return value;
  }

  // ── recurse into containers ──
  if (isRecord(value) && schema.properties) {
    let changed = false;
    const out: Record<string, unknown> = { ...value };
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      const next = coerceValue(`${label}.${key}`, value[key], sub, notes);
      if (next !== value[key]) {
        out[key] = next;
        changed = true;
      }
    }
    return changed ? out : value;
  }
  if (Array.isArray(value) && schema.items) {
    let changed = false;
    const out = value.map((item, i) => {
      const next = coerceValue(`${label}[${i}]`, item, schema.items!, notes);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  return value;
}

/**
 * Coerces a whole arguments object against its tool's schema.
 *
 * Returns the same object reference when nothing needed repairing, so callers
 * can cheaply skip the "arguments repaired" path in the common case.
 */
export function coerceArguments(
  schema: ArgSchema | undefined,
  args: Record<string, unknown>
): CoercionOutcome {
  if (!schema || schema.type !== "object") return { args, notes: [] };
  const notes: string[] = [];
  const out: Record<string, unknown> = { ...args };
  let changed = false;
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (args[key] === undefined) continue;
    const label = `"${key}"`;
    const next = coerceValue(label, args[key], sub, notes);
    if (next !== args[key]) {
      out[key] = next;
      changed = true;
    }
  }
  return { args: changed ? out : args, notes };
}
