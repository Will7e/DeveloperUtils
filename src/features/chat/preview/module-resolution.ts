// ============================================================
// Preview Module Resolution — Repository Dependencies → Import Map
// ============================================================
// The preview bundles workspace source with esbuild, which resolves
// RELATIVE imports through the virtual FS and leaves everything else
// external. That "everything else" used to be a hardcoded React 19 shim,
// so any other package produced a bundle whose first bare import the
// browser could not resolve — and because esbuild had SUCCEEDED, no
// diagnostic was ever produced. The pane went black and blamed nothing.
//
// This module turns the repository's own package.json (and lockfile when
// there is one) into a COMPLETE import map, so every bare specifier the
// bundle emits has a destination. esm.sh is the module host because it
// serves ESM for essentially every package and resolves each package's
// own transitive dependencies server-side, which is the only way a
// browser can consume npm packages without a node_modules tree.
//
// Pure: parses text, builds strings, compares keys. Nothing here touches
// the network, the store, or esbuild — which is what makes the mapping
// rules unit-testable, and what lets the regression suite assert that
// nothing external is ever left unmapped.
//
// Import map semantics (same as the platform's): an exact match wins,
// otherwise the longest prefix ending in "/" wins. `isCoveredByImportMap`
// implements exactly that, because getting it subtly wrong is another
// silent blank frame.
// ============================================================

import { importSpecifiers } from "./vfs";

/** Module host for bare specifiers. Allowed by script-src in both policies. */
export const PREVIEW_CDN = "https://esm.sh";

/**
 * Packages that MUST resolve to the same instance, or React apps die at
 * runtime with "Invalid hook call" / "Cannot read properties of null".
 * esm.sh is told to leave these to the map rather than bundling its own.
 */
const SHARED_INSTANCE_PACKAGES = ["react", "react-dom"];

export interface PackageManifest {
  name: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

/** Reason a specifier could not be mapped, phrased for the user */
export interface UnmappedSpecifier {
  specifier: string;
  reason: string;
}

export interface PreviewImportMap {
  /** The `imports` object handed to the browser */
  imports: Record<string, string>;
  /** Bare specifiers found in the workspace with no destination */
  unmapped: UnmappedSpecifier[];
  /** Versions chosen per package (for diagnostics + tests) */
  resolved: Record<string, string>;
  /** Packages the map knows about, including devDependencies */
  known: Set<string>;
}

// ── Specifier classification ─────────────────────────────────

/**
 * Splits a bare specifier into package name and subpath.
 * `react-dom/client` → { pkg: "react-dom", subpath: "client" }
 * `@radix-ui/react-slot` → { pkg: "@radix-ui/react-slot", subpath: "" }
 * Returns null for relative/absolute/URL specifiers, which the bundler
 * resolves through the virtual FS instead.
 */
export function splitBareSpecifier(
  specifier: string
): { pkg: string; subpath: string } | null {
  const raw = specifier.split("?")[0]?.split("#")[0]?.trim() ?? "";
  if (!raw) return null;
  // Relative, absolute, and protocol/URL forms are the FS resolver's job.
  if (raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("\\")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;

  const parts = raw.split("/");
  const head = parts[0] ?? "";
  if (head.startsWith("@")) {
    // A scope with no package name is not a package.
    if (parts.length < 2 || !parts[1]) return null;
    return { pkg: `${head}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  if (!head) return null;
  return { pkg: head, subpath: parts.slice(1).join("/") };
}

/** Specifiers that exist only in a bundler/Node and can never run in a frame */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
  "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

export function isNodeBuiltin(specifier: string): boolean {
  const raw = specifier.split("?")[0] ?? "";
  if (raw.startsWith("node:")) return true;
  const split = splitBareSpecifier(raw);
  return split ? NODE_BUILTINS.has(split.pkg) : false;
}

/**
 * Specifiers the bundler itself injects or that only Vite can answer.
 * They are reported as their own category so a user does not go looking
 * for a typo in their own imports.
 */
export function isBundlerInternal(specifier: string): boolean {
  const raw = specifier.split("?")[0] ?? "";
  return (
    raw.startsWith("virtual:") ||
    raw.startsWith("\0") ||
    raw.startsWith("@vite/") ||
    raw === "@vite/client" ||
    raw.startsWith("@id/") ||
    raw.startsWith("@rollup/") ||
    raw.startsWith("vite/") ||
    raw.startsWith("virtual/")
  );
}

// ── package.json + lockfile ──────────────────────────────────

function asRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Parses a package.json. Tolerates a missing or malformed file. */
export function parsePackageJson(raw: string | null | undefined): PackageManifest {
  const empty: PackageManifest = {
    name: null,
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
  };
  if (!raw || !raw.trim()) return empty;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return empty;
    return {
      name: typeof parsed.name === "string" ? parsed.name : null,
      dependencies: asRecord(parsed.dependencies),
      devDependencies: asRecord(parsed.devDependencies),
      peerDependencies: asRecord(parsed.peerDependencies),
    };
  } catch {
    return empty;
  }
}

const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json"];

/**
 * Exact installed versions from a package-lock (v2/v3 `packages`, or the
 * v1 nested `dependencies`). Exact beats a range: the preview then runs
 * the version the repository actually pins, so a lockfile and a preview
 * cannot disagree.
 */
export function parseLockfileVersions(raw: string | null | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};

  const out: Record<string, string> = {};
  const record = parsed as Record<string, unknown>;

  // v2/v3: { packages: { "node_modules/react": { version } } }
  const packages = record.packages;
  if (typeof packages === "object" && packages !== null) {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!m) continue;
      const version = (value as { version?: unknown } | null)?.version;
      if (typeof version === "string") out[m[1] as string] = version;
    }
  }

  // v1: { dependencies: { react: { version } } }
  const deps = record.dependencies;
  if (Object.keys(out).length === 0 && typeof deps === "object" && deps !== null) {
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      const version = (value as { version?: unknown } | null)?.version;
      if (typeof version === "string") out[name] = version;
    }
  }
  return out;
}

/** The lockfile to read, preferring the npm one, when it is in the tree */
export function pickLockfilePath(paths: Iterable<string>): string | null {
  const set = new Set(paths);
  for (const name of LOCKFILE_NAMES) {
    if (set.has(name)) return name;
  }
  // pnpm/yarn lockfiles are YAML/JSON-ish and are NOT parsed here: a
  // half-parsed lockfile is worse than none, because it would silently
  // pin wrong versions. Ranges from package.json are used instead.
  return null;
}

// ── Version normalization ────────────────────────────────────

/**
 * Turns a semver range into something a CDN path can carry.
 *
 * esm.sh accepts ranges on the URL (`react@^18`) but `^` has to be
 * percent-encoded to be a legal path, and an encoded range in a specifier
 * people will read in diagnostics is noise. Taking the concrete version
 * out of the range gives the same install in practice and a legible map.
 *
 * Returns null for specifiers that name no published version at all
 * (workspace:, file:, link:, git URLs, `*`, `latest`).
 */
export function normalizeVersion(range: string | undefined): string | null {
  if (!range) return null;
  const value = range.trim();
  if (!value) return null;
  if (/^(workspace|file|link|portal|catalog):/i.test(value)) return null;
  if (/^(git|https?|ssh):/i.test(value) || value.startsWith("github:")) return null;
  if (value === "*" || value === "latest" || value === "next" || value === "canary") return null;

  // Take the first concrete version in the range: ">=1.2.3 <2", "npm:x@^2.0.0",
  // "^1.2.3 || ^2.0.0", "1.2.3-beta.1".
  const npmAlias = /^npm:(.+)$/.exec(value);
  const target = npmAlias ? (npmAlias[1] ?? "") : value;
  const m = /(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?/.exec(target);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}${m[4] ?? ""}`;
}

// ── Import map construction ──────────────────────────────────

/**
 * Every dependency version the repository declares, most-specific source
 * first: exact lockfile pin, then dependencies, then dev/peer.
 */
export function collectDeclaredVersions(
  manifest: PackageManifest,
  lockfileVersions: Record<string, string> = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    out[name] = lockfileVersions[name] ?? range;
  }
  for (const [name, range] of Object.entries(manifest.devDependencies)) {
    out[name] = lockfileVersions[name] ?? range;
  }
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    out[name] = lockfileVersions[name] ?? range;
  }
  return out;
}

/**
 * The module URL for one package. `external=react,react-dom` makes esm.sh
 * leave the shared instances to the map instead of bundling a second
 * copy — the difference between a working React app and "Invalid hook
 * call" with no clue why.
 */
export function packageModuleUrl(pkg: string, version: string | null): string {
  const specifier = version ? `${pkg}@${version}` : pkg;
  const url = `${PREVIEW_CDN}/${specifier}`;
  if (SHARED_INSTANCE_PACKAGES.includes(pkg) && pkg === "react-dom") {
    return `${url}?external=react`;
  }
  return url;
}

/**
 * Builds the import map for a repository.
 *
 * Every declared dependency gets both an exact entry and a trailing-slash
 * entry, so `swiper/css`, `react/jsx-runtime` and `lodash/get` all land
 * somewhere without enumerating subpaths.
 */
export function buildPreviewImportMap(params: {
  manifest: PackageManifest;
  lockfileVersions?: Record<string, string>;
  /** Bare specifiers actually imported by the workspace (for gap reporting) */
  specifiers?: Iterable<string>;
}): PreviewImportMap {
  const declared = collectDeclaredVersions(params.manifest, params.lockfileVersions ?? {});
  const imports: Record<string, string> = {};
  const resolved: Record<string, string> = {};
  const known = new Set<string>();

  for (const [pkg, range] of Object.entries(declared)) {
    const version = normalizeVersion(range);
    // A package we cannot turn into a URL is still "known" — the
    // diagnostic for it must say WHY, not complain the import is unknown.
    resolved[pkg] = version ?? range;
    known.add(pkg);
    if (version === null && !/^[\d.]/.test(range)) {
      // Unresolvable source (workspace:, file:, git) — leave it out of the
      // map so it is reported as a specific failure below.
      continue;
    }
    imports[pkg] = packageModuleUrl(pkg, version ?? null);
    imports[`${pkg}/`] = `${packageModuleUrl(pkg, version ?? null)}/`;
  }

  // jsx-runtime is imported by esbuild's automatic JSX transform for every
  // React app; it is a subpath of react, which the trailing-slash entry
  // already covers, but being explicit keeps the failure mode obvious if
  // react is missing entirely.
  if (imports["react"] && !imports["react/jsx-runtime"]) {
    imports["react/jsx-runtime"] = `${imports["react"]}/jsx-runtime`;
  }

  const unmapped: UnmappedSpecifier[] = [];
  const seen = new Set<string>();
  for (const specifier of params.specifiers ?? []) {
    const split = splitBareSpecifier(specifier);
    if (!split) continue;
    if (seen.has(specifier)) continue;
    seen.add(specifier);

    if (isBundlerInternal(specifier)) continue; // never the user's problem
    if (isNodeBuiltin(specifier)) {
      unmapped.push({
        specifier,
        reason: "a Node.js built-in — it has no browser implementation",
      });
      continue;
    }
    if (isCoveredByImportMap(specifier, imports)) continue;
    if (known.has(split.pkg)) {
      unmapped.push({
        specifier,
        reason: `its declared version ("${declared[split.pkg]}") names no publishable version`,
      });
      continue;
    }
    unmapped.push({
      specifier,
      reason: "it is not in this repository's package.json",
    });
  }

  return { imports, unmapped, resolved, known };
}

/**
 * Import map lookup with the platform's own rules: an exact key wins,
 * otherwise the longest trailing-slash prefix. Implemented here (rather
 * than trusted) because a subtle mismatch means a blank frame again.
 */
export function isCoveredByImportMap(
  specifier: string,
  imports: Record<string, string>
): boolean {
  const raw = specifier.split("?")[0] ?? "";
  if (!raw) return false;
  if (Object.prototype.hasOwnProperty.call(imports, raw)) return true;

  // Longest prefix ending in "/" wins.
  const segments = raw.split("/");
  for (let i = segments.length - 1; i > 0; i--) {
    const prefix = `${segments.slice(0, i).join("/")}/`;
    if (Object.prototype.hasOwnProperty.call(imports, prefix)) return true;
  }
  return false;
}

/**
 * Bare specifiers imported anywhere in the given files.
 * Feeds both the gap report and the regression suite's "nothing external
 * is left without a destination" assertion.
 */
export function collectBareSpecifiers(
  files: Iterable<{ path: string; content: string }>
): string[] {
  const out = new Set<string>();
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
    for (const specifier of importSpecifiers(file.content, file.path)) {
      const split = splitBareSpecifier(specifier);
      // Relative/absolute specifiers are the FS resolver's business; only
      // package names need a destination in the import map.
      if (split !== null) out.add(specifier);
    }
  }
  return [...out];
}

// The scanner lives in ./vfs (shared with the preloader so the two can
// never drift); re-exported here so callers of this module have one import.
export { importSpecifiers as scanImportSpecifiers };
