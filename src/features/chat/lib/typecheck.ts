// ============================================================
// In-Browser Type Checking — Planning & Diagnostic Classification
// ============================================================
// The build path strips types and never checks them, so the agent's
// build signal is type-blind on its own: `const x: string = 42` compiles
// and nothing says otherwise.
//
// The command tiers (`run_command`, `verify_with_ci`) can now run a real
// `tsc`, and they are authoritative when available. This module still earns
// its place: it needs no companion, no install and no push, and it works on
// the workspace revision in front of the user the moment a file changes —
// which is the version of "does this even compile" that can run on every
// turn rather than on request.
//
// This module is the part that can be reasoned about without a compiler:
// which files form the program, what the workspace's own tsconfig means
// for it, which diagnostics are worth reporting, and — most importantly —
// which diagnostics are ARTIFACTS of running without node_modules, since a
// report that cries wolf about missing third-party types is worse than no
// report at all.
//
// The compiler itself runs in a worker (./typecheck.worker) because it is
// both large and blocking. Everything here is pure and unit-tested.
// ============================================================

import { importSpecifiers } from "./import-scan";
import { isNodeBuiltin, splitBareSpecifier } from "./import-scan";

/** TypeScript version used when the repository does not pin one */
export const TYPESCRIPT_FALLBACK_VERSION = "5.9.3";

/** Files one type check will include (a monorepo can exceed this) */
export const TYPECHECK_MAX_FILES = 400;
/** Diagnostics reported after ranking (the rest are counted, not listed) */
export const TYPECHECK_MAX_REPORTED = 40;

/** Paths only the compiler cares about */
const COMPILABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.ts$/;
const IGNORED_DIR = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.turbo|vendor)\//;

export interface TypecheckFile {
  path: string;
  content: string;
}

export interface TypecheckPlan {
  /** Files to compile, repo-relative */
  rootNames: string[];
  /** compilerOptions for ts.createProgram, in plain JSON */
  compilerOptions: Record<string, unknown>;
  /** The repo's declared TypeScript version, when it has one */
  typescriptVersion: string;
  /** Stated limits, printed with every report */
  limits: string[];
  /** True when nothing compilable was found */
  empty: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Options we always impose, whatever the repository's tsconfig says.
 * Each one is a deliberate refusal to reproduce a build environment we do
 * not have:
 *
 *   • noEmit            — we want diagnostics, not output
 *   • skipLibCheck      — third-party .d.ts files are not present anyway
 *   • noErrorTruncation — truncated messages lose the type names that make
 *                         a diagnostic actionable
 */
const FORCED_OPTIONS: Record<string, unknown> = {
  noEmit: true,
  skipLibCheck: true,
  noErrorTruncation: true,
  allowJs: true,
  checkJs: false,
  resolveJsonModule: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  forceConsistentCasingInFileNames: true,
  incremental: false,
  composite: false,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
  isolatedModules: false,
  noEmitOnError: false,
  noResolve: false,
  types: [],
};

/** Options copied from the repository's tsconfig when it declares them */
const INHERITED_OPTIONS = [
  "target",
  "module",
  "moduleResolution",
  "jsx",
  "jsxImportSource",
  "strict",
  "strictNullChecks",
  "noImplicitAny",
  "noUnusedLocals",
  "noUnusedParameters",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "exactOptionalPropertyTypes",
  "useDefineForClassFields",
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "verbatimModuleSyntax",
  "lib",
  "paths",
  "baseUrl",
  "typeRoots",
  "allowImportingTsExtensions",
  "moduleDetection",
] as const;

/**
 * Builds the program plan for a workspace.
 *
 * `changedPaths` is the agent's own change set: diagnostics there are
 * reported first, because a mistake in code the agent just wrote is the
 * one it can still fix this turn.
 */
export function buildTypecheckPlan(params: {
  files: TypecheckFile[];
  /** Parsed tsconfig.json, or null when the repo has none */
  tsconfigRaw?: string | null;
  /** Repo-relative paths in the tree (used to find a nested tsconfig) */
  treePaths?: Iterable<string>;
  changedPaths?: Iterable<string>;
}): TypecheckPlan {
  const limits: string[] = [];
  const declared = parseTsconfig(params.tsconfigRaw);

  const compilerOptions: Record<string, unknown> = {
    ...FORCED_OPTIONS,
    // A default that matches what a modern Vite app compiles to. The
    // repository's own values override these below.
    target: "ES2020",
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
  };
  for (const key of INHERITED_OPTIONS) {
    if (declared[key] !== undefined) compilerOptions[key] = declared[key];
  }
  // `types: []` is forced, but a repo that asked for specific type packages
  // still cannot have them — say so rather than pretend.
  if (Array.isArray(declared.types) && declared.types.length > 0) {
    limits.push(
      `the repository's tsconfig lists type packages (${(declared.types as string[]).join(", ")}) which are not installed here, so their globals are unavailable`
    );
  }
  if (declared.paths !== undefined) {
    // Aliases resolve inside TypeScript the same way they do in the
    // bundler, provided baseUrl is explicit.
    if (declared.baseUrl === undefined) compilerOptions.baseUrl = ".";
  }

  const rootNames = params.files
    .map((f) => f.path)
    .filter((path) => COMPILABLE.test(path))
    .filter((path) => !IGNORED_DIR.test(`/${path}`))
    .sort();

  const truncated = rootNames.length > TYPECHECK_MAX_FILES;
  const capped = truncated ? rootNames.slice(0, TYPECHECK_MAX_FILES) : rootNames;

  if (truncated) {
    limits.push(
      `only the first ${TYPECHECK_MAX_FILES} of ${rootNames.length} source files were checked (a monorepo-sized workspace exceeds the in-browser budget)`
    );
  }
  limits.push(
    "third-party packages are not installed in the browser, so their types are erased to `any`: errors inside DEPENDENCY APIs are not reported, only mistakes in this repository's own code and types"
  );

  return {
    rootNames: capped,
    compilerOptions,
    typescriptVersion: readTypescriptVersion(params.files) ?? TYPESCRIPT_FALLBACK_VERSION,
    limits,
    empty: capped.length === 0,
  };
}

/** The repository's pinned TypeScript version, when package.json declares one */
export function readTypescriptVersion(files: TypecheckFile[]): string | null {
  const pkg = files.find((f) => f.path === "package.json");
  if (!pkg) return null;
  try {
    const parsed = JSON.parse(pkg.content) as Record<string, unknown>;
    const deps = {
      ...asRecord(parsed.dependencies),
      ...asRecord(parsed.devDependencies),
    };
    const range = deps.typescript;
    if (typeof range !== "string") return null;
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
  } catch {
    return null;
  }
}

/**
 * Parses a tsconfig's compilerOptions. JSONC is tolerated, and a broken
 * file degrades to no options rather than failing the whole check.
 */
export function parseTsconfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  let text = raw;
  try {
    const jsonc = stripJsonc(text);
    const parsed = JSON.parse(jsonc) as Record<string, unknown>;
    return asRecord(parsed.compilerOptions);
  } catch {
    text = raw;
    return {};
  }
}

/**
 * Removes comments and trailing commas. Local copy rather than a shared
 * import because this module is loaded by a WORKER, and a worker must not
 * pull in a browser-side dependency graph for a 20-line scanner.
 */
export function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

// ── Ambient declarations for what the browser does not have ──

/**
 * Ambient module declarations that erase every bare import this workspace
 * uses.
 *
 * Only the specifiers actually imported are declared, and only whole
 * package names or the exact subpaths seen. A blanket `declare module "*"`
 * would also erase relative imports, which is precisely the type
 * information worth checking.
 */
export function buildModuleShims(files: TypecheckFile[]): string {
  const specifiers = new Set<string>();
  for (const file of files) {
    if (!COMPILABLE.test(file.path) || DECLARATION.test(file.path)) continue;
    for (const specifier of importSpecifiers(file.content, file.path)) {
      const split = splitBareSpecifier(specifier);
      if (!split) continue;
      if (isNodeBuiltin(specifier)) continue;
      specifiers.add(split.pkg);
      specifiers.add(specifier);
    }
  }
  const lines = [...specifiers].sort().map((s) => `declare module "${s}";`);
  lines.push(
    "",
    "// JSX is erased with react's types, so its namespace is declared here.",
    "declare namespace JSX {",
    "  interface Element { }",
    "  interface ElementClass { }",
    "  interface ElementAttributesProperty { props: unknown }",
    "  interface ElementChildrenAttribute { children: unknown }",
    "  interface IntrinsicElements { [elemName: string]: unknown }",
    "}",
    ""
  );
  return lines.join("\n");
}

// ── Diagnostic classification ────────────────────────────────

export interface RawDiagnostic {
  file: string | null;
  line: number | null;
  code: number;
  message: string;
  category: number;
}

export interface ClassifiedDiagnostics {
  /** Diagnostics worth reporting, ranked */
  reported: RawDiagnostic[];
  /** Count omitted because the cap was reached */
  omitted: number;
  /** Count dropped as artifacts of this environment */
  suppressed: number;
  /** The reasons diagnostics were suppressed, for the stated limits */
  suppressionReasons: string[];
}

/**
 * Diagnostic codes that mean "this environment cannot know", not "your
 * code is wrong". Reporting these would train the agent to distrust the
 * tool, so they are counted and explained instead.
 */
const ENVIRONMENT_CODES: Record<number, string> = {
  2307: "Cannot find module — the package is not installed in the browser",
  2792: "Cannot find module — the package is not installed in the browser",
  2688: "Cannot find type definition file — @types packages are not installed here",
  7016: "a declaration file is missing (the package providing it is not installed)",
  2503: "Cannot find namespace — a library's global namespace is erased",
  2318: "TypeScript's own lib files are unavailable for this type",
  2583: "the requested lib is not loaded",
  2585: "the requested lib is not loaded",
};

/**
 * Ranks diagnostics: the agent's own change set first, then everything
 * else, errors only, deduped, capped.
 */
export function classifyDiagnostics(
  diagnostics: RawDiagnostic[],
  options: { changedPaths?: Iterable<string>; cap?: number } = {}
): ClassifiedDiagnostics {
  const cap = options.cap ?? TYPECHECK_MAX_REPORTED;
  const changed = new Set<string>();
  for (const path of options.changedPaths ?? []) changed.add(path.replace(/^\.\//, ""));

  const suppressionReasons = new Set<string>();
  const kept: RawDiagnostic[] = [];
  const seen = new Set<string>();
  let suppressed = 0;

  for (const diagnostic of diagnostics) {
    // Category 1 is an error; 0 is a warning. Only errors decide whether
    // the change set is sound, but a warning IS worth surfacing when it is
    // in a file the agent just touched.
    const isError = diagnostic.category === 1;
    const inChangeSet = diagnostic.file ? changed.has(diagnostic.file) : false;
    if (!isError && !inChangeSet) continue;

    const environmentReason = ENVIRONMENT_CODES[diagnostic.code];
    if (environmentReason) {
      suppressed++;
      suppressionReasons.add(environmentReason);
      continue;
    }

    const key = `${diagnostic.file ?? "?"}:${diagnostic.line ?? 0}:${diagnostic.code}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(diagnostic);
  }

  kept.sort((a, b) => {
    const aChanged = a.file ? changed.has(a.file) : false;
    const bChanged = b.file ? changed.has(b.file) : false;
    if (aChanged !== bChanged) return aChanged ? -1 : 1;
    if (a.file !== b.file) return (a.file ?? "").localeCompare(b.file ?? "");
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const reported = kept.slice(0, cap);
  return {
    reported,
    omitted: Math.max(0, kept.length - reported.length),
    suppressed,
    suppressionReasons: [...suppressionReasons],
  };
}

/** One diagnostic as a line the model can act on */
export function formatDiagnostic(d: RawDiagnostic): string {
  const location = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "tsconfig";
  const kind = d.category === 1 ? "error" : "warning";
  return `${location} — TS${d.code} ${kind}: ${d.message.replace(/\s+/g, " ").trim()}`;
}

/**
 * The tool-facing report. Its contract is that it always states what it
 * checked, what it could not check, and what it deliberately ignored.
 */
export function formatTypecheckReport(params: {
  plan: TypecheckPlan;
  classification: ClassifiedDiagnostics;
  checkedFiles: number;
  /** Milliseconds the compiler spent, when known */
  durationMs?: number;
  /** Set when the check could not run at all */
  unavailableReason?: string;
}): string {
  const { plan, classification, checkedFiles } = params;

  if (params.unavailableReason) {
    return [
      `TYPECHECK: unavailable — ${params.unavailableReason}`,
      "",
      "This is NOT a pass. Do not claim the code type-checks.",
    ].join("\n");
  }

  const header = `TYPECHECK: ${classification.reported.length === 0 ? "clean" : `${classification.reported.filter((d) => d.category === 1).length} error(s)`}`;
  const meta = [
    `${checkedFiles} file(s) checked`,
    `TypeScript ${plan.typescriptVersion}`,
    params.durationMs !== undefined ? `${params.durationMs}ms` : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" · ");

  const lines: string[] = [header, meta, ""];

  if (classification.reported.length === 0) {
    lines.push(
      "No type errors in this repository's own sources.",
      "Importantly: this is a type check, not a test run and not a build."
    );
  } else {
    lines.push("Diagnostics (your changed files first):");
    for (const diagnostic of classification.reported) {
      lines.push(`- ${formatDiagnostic(diagnostic)}`);
    }
    if (classification.omitted > 0) {
      lines.push(`…and ${classification.omitted} more diagnostic(s) beyond the report cap.`);
    }
  }

  if (classification.suppressed > 0) {
    lines.push("");
    lines.push(
      `Ignored ${classification.suppressed} diagnostic(s) this environment cannot judge:`
    );
    for (const reason of classification.suppressionReasons) {
      lines.push(`- ${reason}`);
    }
  }

  if (plan.limits.length > 0) {
    lines.push("");
    lines.push("Limits of this check:");
    for (const limit of plan.limits) lines.push(`- ${limit}`);
  }

  return lines.join("\n");
}
