// ============================================================
// Preview Bundle — One Self-Contained File Out of a Workspace
// ============================================================
// Owns the esbuild call and nothing else. Everything specific to WHAT is
// being bundled lives in ./graph (resolution and loading) and ./assets
// (what a file is); everything specific to what the frame receives lives in
// ./document.
//
// The output contract is deliberately strict, because it is what the whole
// rewrite buys: a single ESM module with NO external references left. A
// leftover import would be a request the browser has to resolve at runtime
// with nothing but an import map to resolve it — the design that produced
// "blocked due to backtracking" and blank frames. When an import cannot be
// satisfied, this build FAILS and says which specifier and why.
//
// `esbuild.initialize()` is the caller's job: the browser needs a wasm URL
// and a worker, the test needs neither, and initializing twice throws.
// ============================================================

import * as esbuild from "esbuild-wasm";

/**
 * Prepended to every bundle, and named by the define map in place of
 * `import.meta.glob` (see ./env).
 *
 * It exists for the call the build could NOT rewrite — a computed pattern, an
 * unsupported option, a glob inside a fetched package. Without it the app
 * fails with `TypeError: (intermediate value).glob is not a function`, which
 * names neither the file nor the api; with it, it fails with a sentence that
 * says what happened and where to look.
 */
const GLOB_UNAVAILABLE_PRELUDE = `const __intabGlobUnavailable = () => {
  throw new Error("import.meta.glob could not be resolved for this preview: the preview rewrites static patterns while building, and this call is not one it could rewrite (a computed pattern or an unsupported option). The build diagnostics name the file.");
};`;
import type { VFS } from "./vfs";
import type { AliasConfig } from "./aliases";
import type { CssPlan } from "./css-pipeline";
import type { PreviewDiagnostic } from "./preview.store";
import {
  createGraphReport,
  workspaceGraphPlugin,
  type GraphPorts,
  type GraphReport,
  type PackageVersions,
} from "./graph";

export interface BundleRequest {
  /** Workspace-relative entry module (e.g. `src/main.tsx`) */
  entry: string;
  vfs: VFS;
  aliases: AliasConfig;
  /** pkg → pinned version, the single source of truth for what gets fetched */
  versions: PackageVersions;
  /** `import.meta.env` + NODE_ENV substitutions from the repository's .env */
  define: Record<string, string>;
  cssPlan: CssPlan;
  ports: GraphPorts;
}

export interface BundleOutput {
  status: "ready" | "error";
  /** The bundle. A single ESM module with no remaining imports. */
  js: string;
  /** Everything esbuild emitted as CSS, concatenated */
  css: string;
  report: GraphReport;
  diagnostics: PreviewDiagnostic[];
}

/** esbuild's message → the pane's diagnostic shape */
function toDiagnostic(m: esbuild.Message, severity: "error" | "warning"): PreviewDiagnostic {
  return {
    // The `vfs:` namespace is how esbuild addresses workspace files, not
    // anything a reader of the pane should have to decode.
    file: m.location?.file?.replace(/^vfs:/, ""),
    line: m.location?.line,
    message: [m.text, ...(m.notes ?? []).map((n) => n.text)].filter(Boolean).join("\n"),
    severity,
  };
}

/**
 * Bundles one workspace into one module.
 *
 * Never throws: a failed build is a value with `status: "error"` and the
 * diagnostics that explain it. A thrown error here would reach the pane as
 * a single opaque string, which is how a broken preview used to become an
 * empty frame with no reason attached.
 */
export async function bundleWorkspace(request: BundleRequest): Promise<BundleOutput> {
  const report = createGraphReport();
  const { entry, vfs, aliases, versions, define, cssPlan, ports } = request;
  const diagnostics: PreviewDiagnostic[] = [];

  let result: esbuild.BuildResult;
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      // A browser app: this is what selects browser conditions in the
      // packages we fetch and keeps esbuild from assuming Node globals.
      platform: "browser",
      target: "es2020",
      jsx: "automatic",
      jsxImportSource: "react",
      outdir: "/out",
      define,
      logLevel: "silent",
      plugins: [workspaceGraphPlugin({ vfs, aliases, versions, cssPlan, report, ports })],
    });
  } catch (err) {
    const thrown = err as { errors?: esbuild.Message[]; message?: string };
    if (thrown?.errors?.length) {
      for (const m of thrown.errors) diagnostics.push(toDiagnostic(m, "error"));
    } else {
      diagnostics.push({
        message: thrown?.message ?? "The bundle failed with no error detail.",
        severity: "error",
      });
    }
    return { status: "error", js: "", css: "", report, diagnostics };
  }

  // A warning inside a PACKAGE's own build output is not the user's to fix:
  // esm.sh serves minified code, and "this case clause will never be evaluated"
  // from inside html2canvas is noise that buries the diagnostics that matter.
  // Counted rather than listed, and never applied to errors.
  let suppressedRemoteWarnings = 0;
  for (const m of result.warnings ?? []) {
    if (m.location?.file?.startsWith("cdn:")) {
      suppressedRemoteWarnings++;
      continue;
    }
    diagnostics.push(toDiagnostic(m, "warning"));
  }
  if (suppressedRemoteWarnings > 0) {
    diagnostics.push({
      message: `${suppressedRemoteWarnings} warning(s) from package sources were not shown: they are inside a dependency's own build output, which nothing in this repository can fix.`,
      severity: "warning",
    });
  }

  if (result.errors.length > 0) {
    for (const m of result.errors) diagnostics.push(toDiagnostic(m, "error"));
    return { status: "error", js: "", css: "", report, diagnostics };
  }

  let js = "";
  const cssParts: string[] = [];
  for (const file of result.outputFiles ?? []) {
    if (file.path.endsWith(".css")) cssParts.push(file.text);
    else if (file.path.endsWith(".js")) js += file.text;
  }
  js = `${GLOB_UNAVAILABLE_PRELUDE}\n${js}`;

  diagnostics.push(...describeBundle(report));
  return { status: "ready", js, css: cssParts.join("\n\n"), report, diagnostics };
}

/**
 * The build's own account of what it had to work around. These are the
 * lines that turn "the preview is broken" into a specific, checkable
 * statement — every one of them names files.
 */
function describeBundle(report: GraphReport): PreviewDiagnostic[] {
  const out: PreviewDiagnostic[] = [];

  if (report.unresolved.size > 0) {
    const lines = [...report.unresolved]
      .map(([specifier, reason]) => `- ${specifier}: ${reason}`)
      .sort();
    out.push({
      message: `These imports could not be resolved, so the app will not start:\n${lines.join("\n")}`,
      severity: "error",
    });
  }
  if (report.unavailableAssets.size > 0) {
    out.push({
      message:
        `These assets could not be inlined, so the preview shows a placeholder: ${[...report.unavailableAssets].sort().join(", ")}. ` +
        "A file over the GitHub Contents API's 1 MB limit, or one that could not be fetched, cannot be embedded in the bundle — the app still runs without it.",
      severity: "warning",
    });
  }
  if (report.queryStripped.size > 0) {
    out.push({
      message: `Vite query imports were loaded without their suffix (the browser has no equivalent): ${[...report.queryStripped].sort().join(", ")}.`,
      severity: "warning",
    });
  }
  if (report.strippedCss.length > 0) {
    out.push({
      message: `Removed ${report.strippedCss.length} vendor CSS import(s) the browser cannot fetch: ${[...new Set(report.strippedCss)].sort().join(", ")}. See the CSS notes above for what this costs.`,
      severity: "warning",
    });
  }
  if (report.globUnsupported.size > 0) {
    const lines = [...report.globUnsupported]
      .map(([where, why]) => `- ${where}: ${why}`)
      .sort()
      .join("\n");
    out.push({
      message:
        `These import.meta.glob calls could not be rewritten while building, so the app will throw where it calls them:\n${lines}`,
      severity: "error",
    });
  }
  if (report.stubbed.size > 0) {
    out.push({
      message: `Replaced bundler-only imports with an empty module: ${[...report.stubbed].sort().join(", ")}.`,
      severity: "warning",
    });
  }

  return out;
}
