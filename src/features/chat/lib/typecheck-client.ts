// ============================================================
// Type Check Client — Owning the Worker and the Tool Report
// ============================================================
// The page-facing half of the in-browser type check: it builds the plan,
// runs the compiler in a worker, classifies the result and formats the
// report the agent reads.
//
// The single most important property here is that FAILURE IS NEVER A PASS.
// Every path that cannot actually check something — no source files, a
// compiler that would not load, a timeout, a crash — returns an
// `unavailableReason`, and the report says so in words. A tool that
// silently returns "0 errors" when it did not run is worse than no tool,
// because a model will repeat it as a verified claim.
// ============================================================

import {
  buildTypecheckPlan,
  classifyDiagnostics,
  formatTypecheckReport,
  TYPECHECK_MAX_FILES,
  type ClassifiedDiagnostics,
  type RawDiagnostic,
  type TypecheckFile,
  type TypecheckPlan,
} from "./typecheck";

/** How long one compile may take before the request is abandoned */
export const TYPECHECK_TIMEOUT_MS = 90_000;
/** How long an idle worker is kept warm (compiler parse is expensive) */
export const TYPECHECK_WORKER_IDLE_MS = 5 * 60_000;

export interface TypecheckResult {
  /** True when a compile actually ran */
  ok: boolean;
  /** The text the tool returns — always states its own limits */
  report: string;
  classification: ClassifiedDiagnostics;
  plan: TypecheckPlan;
  checkedFiles: number;
  unavailableReason?: string;
}

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let requestSeq = 0;

/** Creates (or reuses) the compiler worker */
function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./typecheck.worker.ts", import.meta.url), {
    type: "module",
    name: "intab-typecheck",
  });
  worker.addEventListener("error", () => {
    // A worker that fails to load leaves every later request hanging, so
    // drop it and let the next call try again.
    disposeWorker();
  });
  return worker;
}

function disposeWorker(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function scheduleIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(disposeWorker, TYPECHECK_WORKER_IDLE_MS);
}

/**
 * Translates the repository's compiler options into the worker's VIRTUAL
 * file system, where every path is rooted at "/".
 *
 * `baseUrl` and `paths` are the reason this cannot be skipped: a tsconfig
 * says `"@/*": ["./src/*"]` relative to ITSELF, and the same rule must
 * resolve to `/src/*` inside the worker or every aliased import becomes a
 * "cannot find module" error.
 */
export function toVirtualCompilerOptions(
  options: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...options };

  const rawBase = typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const base = rawBase.replace(/^\.\/?/, "").replace(/\/+$/, "");
  out.baseUrl = base && base !== "." ? `/${base}` : "/";

  if (options.paths && typeof options.paths === "object" && !Array.isArray(options.paths)) {
    const paths: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      paths[pattern] = targets
        .filter((t): t is string => typeof t === "string")
        .map((target) => {
          // Only the leading location changes. A star is NOT appended when
          // the target lacks one: TypeScript treats a target without a star
          // as a literal mapping, so adding one would invent a rule the
          // repository never wrote.
          const cleaned = target.replace(/^\.\//, "").replace(/^\/+/, "");
          return `/${cleaned}`;
        });
    }
    out.paths = paths;
  }

  return out;
}

/**
 * Runs a type check over the workspace.
 *
 * Never throws, and never reports a pass it did not earn.
 */
export async function runTypecheck(params: {
  files: TypecheckFile[];
  tsconfigRaw?: string | null;
  treePaths?: Iterable<string>;
  changedPaths?: Iterable<string>;
}): Promise<TypecheckResult> {
  const plan = buildTypecheckPlan({
    files: params.files,
    tsconfigRaw: params.tsconfigRaw,
    treePaths: params.treePaths,
    changedPaths: params.changedPaths,
  });

  const unavailable = (reason: string): TypecheckResult => ({
    ok: false,
    unavailableReason: reason,
    plan,
    checkedFiles: 0,
    classification: { reported: [], omitted: 0, suppressed: 0, suppressionReasons: [] },
    report: formatTypecheckReport({
      plan,
      classification: { reported: [], omitted: 0, suppressed: 0, suppressionReasons: [] },
      checkedFiles: 0,
      unavailableReason: reason,
    }),
  });

  if (plan.empty) {
    return unavailable("the workspace holds no TypeScript or JavaScript files to check.");
  }
  if (plan.rootNames.length > TYPECHECK_MAX_FILES) {
    // buildTypecheckPlan already capped and noted it, so this is only a
    // guard against a workspace far beyond the budget.
    return unavailable(
      `this workspace has ${plan.rootNames.length} source files, beyond the in-browser budget of ${TYPECHECK_MAX_FILES}.`
    );
  }

  const id = ++requestSeq;
  // Files and roots are both rooted at "/" so the compiler's own path
  // arithmetic cannot diverge from the host lookups.
  const virtualFiles: Record<string, string> = {};
  for (const file of params.files) {
    if (!plan.rootNames.includes(file.path) && file.path !== "package.json") continue;
    virtualFiles[`/${file.path}`] = file.content;
  }
  const rootNames = plan.rootNames.map((path) => `/${path}`);

  const response = await new Promise<
    { ok: boolean; diagnostics: RawDiagnostic[]; notes: string[]; error?: string } | "timeout" | "failed"
  >((resolve) => {
    let settled = false;
    const finish = (
      value: { ok: boolean; diagnostics: RawDiagnostic[]; notes: string[]; error?: string } | "timeout" | "failed"
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.removeEventListener("message", onMessage);
      resolve(value);
    };

    const timer = setTimeout(() => finish("timeout"), TYPECHECK_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        kind?: string;
        id?: number;
        ok?: boolean;
        diagnostics?: RawDiagnostic[];
        notes?: string[];
        error?: string;
      } | null;
      if (!data || data.kind !== "typecheck-result" || data.id !== id) return;
      finish({
        ok: data.ok === true,
        diagnostics: data.diagnostics ?? [],
        notes: data.notes ?? [],
        error: data.error,
      });
    };

    let active: Worker;
    try {
      active = ensureWorker();
    } catch (err) {
      finish("failed");
      void err;
      return;
    }
    active.addEventListener("message", onMessage);
    try {
      active.postMessage({
        kind: "typecheck",
        id,
        version: plan.typescriptVersion,
        files: virtualFiles,
        rootNames,
        compilerOptions: toVirtualCompilerOptions(plan.compilerOptions),
      });
    } catch {
      finish("failed");
    }
  });

  if (response === "timeout") {
    disposeWorker();
    return unavailable(
      `the in-browser compiler did not finish within ${Math.round(TYPECHECK_TIMEOUT_MS / 1000)}s (it runs in a worker with a hard deadline so a pathological project cannot hang the app).`
    );
  }
  if (response === "failed") {
    disposeWorker();
    return unavailable(
      "the in-browser TypeScript compiler could not be started (the module host was unreachable, or a content-security policy blocked it)."
    );
  }
  if (!response.ok) {
    return unavailable(response.error ?? "the compiler failed without a message.");
  }

  scheduleIdleDispose();

  const classification = classifyDiagnostics(response.diagnostics, {
    changedPaths: params.changedPaths,
  });
  // Any environment note the worker added is a stated limit, not a
  // diagnostic: it belongs with the rest of them.
  const planWithNotes: TypecheckPlan = {
    ...plan,
    limits: [...plan.limits, ...response.notes.filter((note) => note.includes("lib"))],
  };

  return {
    ok: true,
    plan: planWithNotes,
    checkedFiles: plan.rootNames.length,
    classification,
    report: formatTypecheckReport({
      plan: planWithNotes,
      classification,
      checkedFiles: plan.rootNames.length,
    }),
  };
}

/** Frees the compiler worker immediately (tests, teardown) */
export function stopTypecheckWorker(): void {
  disposeWorker();
}
