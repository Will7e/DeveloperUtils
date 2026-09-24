// ============================================================
// Tool Program Interpreter — Batched Read-Only Tool Programs
// ============================================================
// Programmatic tool calling (PTC-lite), adapted from DeepSeek
// Harness's Code Mode idea: instead of one round trip per tool call,
// the model emits ONE call containing a small step list of read-only
// repo tools. The interpreter runs the steps in-process, letting
// later steps reference earlier results via "$name.path.to.value",
// and returns a single aggregated result.
//
// Deliberately NOT Code Mode: no eval, no arbitrary JS, no loops,
// no conditionals — a bounded opcode interpreter. Write/ship tools
// are whitelisted out. Per-step results reuse the session tool cache
// (tool-cache.ts) via the same key builder the runner uses.
//
// Failure model: parse failures and hard-cap violations fail the
// whole program (cheap, deterministic). Per-step failures (network,
// missing file) are recorded per step and the program continues —
// matching how single tool failures already surface to the model.

import {
  TOOL_PROGRAM_MAX_CHARS,
  TOOL_PROGRAM_MAX_STEPS,
} from "../constants";
import {
  toolCacheKey,
  lookupToolCache,
  storeToolCache,
  type ReadView,
} from "./tool-cache";
import { PROGRAMMABLE_TOOL_NAMES } from "./tool-registry";
import type {
  RepoContext,
  ToolCallRequest,
  ToolCallResult,
  ToolName,
} from "../types";

/**
 * Tools allowed inside a program come from the registry's
 * `programmable` flag (read-only, cache-friendly today) — one source
 * of truth instead of a second hard-coded whitelist here.
 */
const PROGRAMMABLE_TOOLS: ReadonlySet<string> = PROGRAMMABLE_TOOL_NAMES;

/** Aggregate per-step args size cap (blocks megabyte programs) */
const MAX_STEP_ARGS_CHARS = 2_000;

/** One step of a tool program */
export interface ProgramStep {
  /** Variable name to bind the (relevant) result to — "readme", "cfg" */
  read?: string;
  /** The read-only tool to invoke */
  tool: ToolName;
  /** Tool arguments; string values may reference earlier results */
  args?: Record<string, unknown>;
}

/** Validated shape of a model-submitted program */
export interface ParsedProgram {
  steps: ProgramStep[];
}

export interface RunToolProgramParams {
  /** The raw model arguments JSON containing { program: [...] } */
  call: ToolCallRequest;
  repo: RepoContext;
  token: string;
  signal?: AbortSignal;
  /**
   * The revision the steps read through (see tool-cache.ReadView).
   *
   * Passed in rather than derived here, because the steps run through the same
   * workspace-first read tools as plain calls: a program cached under the
   * repository alone would replay one agent's working copy into another's step
   * results, which is worse than a cache miss because the output is then bound
   * to a variable and quoted.
   */
  view?: ReadView | null;
  /** Executes one whitelisted tool (wired to executeToolCall by tools.ts) */
  execute: (call: ToolCallRequest) => Promise<ToolCallResult>;
}

/** Program execution summary returned as the tool result payload */
export interface ProgramRunResult {
  steps: number;
  ok: number;
  failed: number;
  /** Per-step lines: status, bound name, tool, summary line */
  log: string[];
  /** Aggregated, size-capped model-facing output */
  output: string;
}

// ── Parsing ──────────────────────────────────────────────────

function parseError(reason: string): ToolCallResult {
  return {
    callId: "",
    name: "run_tool_program",
    ok: false,
    data: {
      error: `Invalid tool program: ${reason}`,
      hint: 'arguments must be {"program": [{"read":"name","tool":"read_file","args":{"path":"src/a.ts"}}, ...]} — max 8 steps, read-only tools only (list_repo_files, read_file, search_code, get_repo_overview).',
    },
    durationMs: 0,
    summary: "invalid program",
  };
}

/** Narrow-structure check without over-validating contents */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses + validates the model's raw arguments into a program */
export function parseToolProgram(rawArgs: string): ParsedProgram | ToolCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs || "{}");
  } catch {
    return parseError("arguments are not valid JSON");
  }
  if (!isRecord(parsed)) return parseError("arguments must be an object");

  const program = parsed.program;
  if (!Array.isArray(program)) return parseError('"program" must be an array of steps');
  if (program.length === 0) return parseError("program is empty");
  if (program.length > TOOL_PROGRAM_MAX_STEPS) {
    return parseError(`program has ${program.length} steps; max is ${TOOL_PROGRAM_MAX_STEPS}`);
  }

  const steps: ProgramStep[] = [];
  let argsChars = 0;
  for (let i = 0; i < program.length; i++) {
    const raw = program[i];
    if (!isRecord(raw)) return parseError(`step ${i} must be an object`);
    const tool = raw.tool;
    if (typeof tool !== "string" || !PROGRAMMABLE_TOOLS.has(tool)) {
      return parseError(
        `step ${i}: tool must be one of ${[...PROGRAMMABLE_TOOLS].join(", ")}`
      );
    }
    if (raw.args !== undefined && !isRecord(raw.args)) {
      return parseError(`step ${i}: args must be an object`);
    }
    if (raw.read !== undefined && typeof raw.read !== "string") {
      return parseError(`step ${i}: "read" must be a string variable name`);
    }
    const read = typeof raw.read === "string" ? raw.read.trim() : undefined;
    if (read !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(read)) {
      return parseError(`step ${i}: "read" must match [A-Za-z_][A-Za-z0-9_]{0,31}`);
    }
    const args = (raw.args ?? {}) as Record<string, unknown>;

    // Args budget: bounded program size, no megabyte payloads
    const argsLen = JSON.stringify(args ?? {}).length;
    argsChars += argsLen;
    if (argsChars > MAX_STEP_ARGS_CHARS) {
      return parseError(`combined step args exceed ${MAX_STEP_ARGS_CHARS} chars`);
    }

    steps.push({ read, tool: tool as ToolName, args });
  }
  return { steps };
}

// ── Reference resolution ─────────────────────────────────────

// Group 1 = variable name, group 2 = the dot/bracket path (may be empty)
const REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]{0,31})((?:\.[A-Za-z_][A-Za-z0-9_]{0,31}|\[\d+\]){0,5})$/;

/** True when the string is a $var.path reference */
export function isVarRef(value: string): boolean {
  return REF_PATTERN.test(value);
}

/** Resolves "$name.a.b[0]" against the bound variable table */
export function resolveVarRef(ref: string, vars: Record<string, unknown>): unknown {
  const m = REF_PATTERN.exec(ref);
  if (!m) return undefined;
  const [name, path] = [m[1]!, m[2]!];
  let cursor: unknown = vars[name];
  if (path) {
    // Tokenize ".name" and "[idx]" segments directly — the path capture
    // starts with its leading dot and brackets ride mid-segment, so a
    // naive split(".") would produce a phantom empty key.
    const segRe = /\.([A-Za-z_][A-Za-z0-9_]{0,31})|\[(\d+)\]/g;
    let seg: RegExpExecArray | null;
    while ((seg = segRe.exec(path)) !== null) {
      if (cursor === null || cursor === undefined) return undefined;
      if (seg[1] !== undefined) {
        // Name access must traverse arrays too (e.g. $hits.results[0]
        // where `hits` IS the results array from search_code).
        cursor =
          typeof cursor === "object" && cursor !== null
            ? (cursor as Record<string, unknown>)[seg[1]]
            : undefined;
      } else {
        cursor = Array.isArray(cursor) ? cursor[Number(seg[2])] : undefined;
      }
    }
  }
  return cursor;
}

/** Substitutes $refs inside step args (top-level strings and one nesting level) */
function resolveStepArgs(
  args: Record<string, unknown>,
  vars: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && isVarRef(v)) {
      out[k] = resolveVarRef(v, vars);
    } else if (isRecord(v)) {
      const nested: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(v)) {
        nested[nk] =
          typeof nv === "string" && isVarRef(nv) ? resolveVarRef(nv, vars) : nv;
      }
      out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Output shaping ───────────────────────────────────────────

/** Clamps one step's output section into the aggregate budget */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[clipped ${text.length - max} chars]`;
}

/**
 * The value a step binds for $ref lookups: the tool's full result
 * data object, so refs mirror the tools' documented result shapes
 * ($src.content for read_file, $hits.results[0].path for search_code).
 */
function bindValue(result: ToolCallResult): unknown {
  return result.data;
}

/** Human line for a step in the program log */
function stepLogLine(step: ProgramStep, result: ToolCallResult): string {
  const status = result.ok ? "ok" : "FAIL";
  const name = step.read ? `${step.read} = ` : "";
  const detail =
    (typeof result.summary === "string" && result.summary) ||
    (isRecord(result.data) && typeof (result.data as Record<string, unknown>).error === "string"
      ? String((result.data as Record<string, unknown>).error)
      : "done");
  return `${status}  ${name}${step.tool}(${detail})`.slice(0, 160);
}

// ── Execution ────────────────────────────────────────────────

/**
 * Runs one parsed program: sequential steps against the injected
 * executor, per-step cache reuse, $ref substitution, aggregate
 * budget. Never throws.
 */
export async function runToolProgram(
  params: RunToolProgramParams
): Promise<ToolCallResult> {
  const started = Date.now();
  const { call, repo, token, signal, view, execute } = params;

  const parsed = parseToolProgram(call.arguments);
  if ("data" in parsed) {
    return { ...parsed, callId: call.id, durationMs: Date.now() - started };
  }
  const { steps } = parsed;

  const vars: Record<string, unknown> = {};
  const log: string[] = [];
  const sections: string[] = [];
  let usedChars = 0;
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) {
      return {
        callId: call.id,
        name: "run_tool_program",
        ok: false,
        data: {
          steps: i,
          ok: okCount,
          failed: failCount,
          log,
          error: "Aborted by the user.",
        },
        durationMs: Date.now() - started,
        summary: `program (${i}/${steps.length} steps, aborted)`,
      };
    }

    const step = steps[i]!;
    const args = resolveStepArgs(step.args ?? {}, vars);

    // Validate the whitelisted tools' required args after substitution
    if (step.tool === "read_file" && typeof args.path !== "string") {
      // Possibly an unresolvable ref — fail this step, continue program
      failCount++;
      log.push(`FAIL  ${step.read ? `${step.read} = ` : ""}${step.tool}(missing "path" after $ref resolution)`);
      continue;
    }
    if (step.tool === "search_code" && typeof args.query !== "string") {
      failCount++;
      log.push(`FAIL  ${step.read ? `${step.read} = ` : ""}${step.tool}(missing "query" after $ref resolution)`);
      continue;
    }

    // Session cache: same key builder the runner uses for plain calls
    const pseudo: ToolCallRequest = { id: call.id, name: step.tool, arguments: JSON.stringify(args) };
    const cacheKey = toolCacheKey(pseudo, repo, view);
    const hit = lookupToolCache(cacheKey);
    if (hit) {
      okCount++;
      log.push(stepLogLine(step, hit));
      sections.push(`## step ${i}: ${step.tool} — cached\n${clamp(stringifyForOutput(bindValue(hit)), 2_000)}`);
      if (step.read) {
        vars[step.read] = bindValue(hit);
      }
      usedChars += (sections[sections.length - 1] ?? "").length;
      if (usedChars > TOOL_PROGRAM_MAX_CHARS) {
        log.push(`…program output budget (${TOOL_PROGRAM_MAX_CHARS} chars) reached; remaining steps skipped`);
        break;
      }
      continue;
    }

    let result: ToolCallResult;
    try {
      result = await execute({ id: `${call.id}:${i}`, name: step.tool, arguments: JSON.stringify(args) });
    } catch (err) {
      // Executor should not throw, but never let one step kill the program
      result = {
        callId: `${call.id}:${i}`,
        name: step.tool,
        ok: false,
        data: { error: err instanceof Error ? err.message : "step failed unexpectedly" },
        durationMs: 0,
        summary: step.tool,
      };
    }

    if (result.ok) {
      okCount++;
      storeToolCache(cacheKey, result);
    } else {
      failCount++;
    }
    log.push(stepLogLine(step, result));
    sections.push(`## step ${i}: ${step.tool}${result.ok ? "" : " — FAILED"}\n${clamp(stringifyForOutput(bindValue(result)), 2_000)}`);
    // Bind only successful results: a ref to a failed step stays
    // unresolvable, so dependent steps fail loudly instead of
    // receiving an error payload as their arguments.
    if (step.read && result.ok) {
      vars[step.read] = bindValue(result);
    }
    usedChars += (sections[sections.length - 1] ?? "").length;
    if (usedChars > TOOL_PROGRAM_MAX_CHARS) {
      log.push(`…program output budget (${TOOL_PROGRAM_MAX_CHARS} chars) reached; remaining steps skipped`);
      break;
    }
  }

  const okOverall = failCount === 0;
  // Note: `ok` is true only when EVERY step succeeded. Partial
  // failures still deliver the aggregated output below — per-step
  // statuses ride in `log` so the model can adapt.
  const output = [
    `Program: ${steps.length} steps — ${okCount} ok, ${failCount} failed`,
    ...log.map((l) => `- ${l}`),
    "",
    ...sections,
  ].join("\n");

  return {
    callId: call.id,
    name: "run_tool_program",
    ok: okOverall,
    data: {
      steps: steps.length,
      ok: okCount,
      failed: failCount,
      log,
      output: clamp(output, TOOL_PROGRAM_MAX_CHARS),
    } satisfies ProgramRunResult,
    durationMs: Date.now() - started,
    summary: `program: ${steps.length} steps, ${okCount} ok, ${failCount} failed`,
  };
}

/** Stringifies a bound value for the aggregate output section */
function stringifyForOutput(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "(undefined)";
  try {
    return JSON.stringify(v, null, 1) ?? "(unserializable)";
  } catch {
    return "(unserializable)";
  }
}
