// ============================================================
// Preview CDN — The One Place a Package URL Is Decided
// ============================================================
// Packages come from a module host (esm.sh) that returns real ESM source.
// The rewrite's central change is HOW that source is used: the bundler
// FETCHES it, during the build, and compiles it into the single output
// file — instead of leaving a bare `import "react"` in the bundle for the
// browser to resolve at runtime through an import map.
//
// That difference removes a whole class of failures:
//
//   • No import map, so no runtime resolution at all. The platform's
//     prefix rules ("blocked due to backtracking"), the exact-key vs
//     trailing-slash precedence, and the "failed to resolve module
//     specifier" abort cannot happen — there is nothing left to resolve.
//   • One React, by construction. esbuild caches a module per (namespace,
//     path), and a package's path here IS its URL, so two importers that
//     name react reach the same module object or they do not reach react
//     at all. The previous design had to ASK esm.sh not to inline a second
//     copy and hope every package was asked.
//   • Failures arrive during the build, as diagnostics, with the file and
//     the specifier — instead of as an uncaught TypeError in the frame.
//
// `external=` is still load-bearing, and for the opposite reason: it makes
// esm.sh leave a shared dependency OUT of the source it returns, so our
// bundler is the only thing that decides which copy exists.
//
// Pure: strings in, strings out.
// ============================================================

/** Module host for bare specifiers. Allowed by connect-src in both policies. */
export const PREVIEW_CDN = "https://esm.sh";

/**
 * Packages that MUST be a single instance, or a React app dies with
 * "Invalid hook call" / a TypeError from inside react.mjs whose text names
 * nothing useful.
 */
export const SHARED_INSTANCE_PACKAGES: readonly string[] = ["react", "react-dom"];

/**
 * The `external=` query for a package's module URL.
 *
 * Every package is asked to leave the shared instances out of its own
 * build, not just react-dom. esm.sh inlines a private copy of a dependency
 * into each package that imports it, so `lucide-react` and `@radix-ui/*`
 * would otherwise arrive each carrying their own React — whose internals
 * are not the ones react-dom/client renders with. esm.sh ignores an
 * external a package never imports, so asking broadly is free; guessing
 * per package is what produced a blank frame.
 *
 * react IS the instance: it externalizes nothing.
 */
export function externalQuery(pkg: string): string {
  if (pkg === "react") return "";
  const external = SHARED_INSTANCE_PACKAGES.filter((p) => p !== pkg);
  return external.length > 0 ? `?external=${external.join(",")}` : "";
}

/**
 * The module host URL for a package, optionally one of its subpaths.
 *
 * The subpath goes BEFORE the query. A `?` in the middle of a path is not
 * a path: `react-dom@19/client?external=react` and
 * `react-dom@19?external=react/client` request different things, and only
 * the first one exists.
 */
export function moduleUrl(pkg: string, version: string | null, subpath = ""): string {
  const specifier = version ? `${pkg}@${version}` : pkg;
  const suffix = subpath.replace(/^\/+|\/+$/g, "");
  const base = suffix ? `${PREVIEW_CDN}/${specifier}/${suffix}` : `${PREVIEW_CDN}/${specifier}`;
  return `${base}${externalQuery(pkg)}`;
}

/** True when a specifier is already an absolute http(s) URL */
export function isAbsoluteUrl(specifier: string): boolean {
  return /^https?:\/\//i.test(specifier);
}

/**
 * Resolves a specifier that appears INSIDE a module we fetched from the
 * host. esm.sh's own output refers to sibling and build paths —
 * `/v135/react@19/file.mjs`, `./chunk.mjs`, an absolute URL — and every
 * one of those is resolved against the module's own URL, which is the only
 * base that means anything here.
 *
 * Returns null when the specifier is not a URL form at all (a bare package
 * name), so the caller can send it through package resolution instead.
 */
export function resolveFromModuleUrl(
  moduleUrlBase: string,
  specifier: string
): string | null {
  if (isAbsoluteUrl(specifier)) return specifier;
  if (!specifier.startsWith("/") && !specifier.startsWith("./") && !specifier.startsWith("../")) {
    return null;
  }
  try {
    return new URL(specifier, moduleUrlBase).href;
  } catch {
    return null;
  }
}
