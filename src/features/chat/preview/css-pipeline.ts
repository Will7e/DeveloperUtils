// ============================================================
// Preview CSS Pipeline — Framework Detection & Vendor Directive Handling
// ============================================================
// esbuild compiles plain CSS, and that is all the preview used to do. The
// most common front-end entry file in a Vite project starts with
//
//     @import "tailwindcss";
//
// which esbuild reads as an import of a PACKAGE — there is no node_modules
// in the workspace, so it either fails the build or externalizes a
// directive the browser cannot use. Either way the result is unstyled HTML,
// which a user reasonably reads as "the preview is broken".
//
// This module decides, per repository, what the preview can honestly do:
//   • Tailwind v4 (the `@import "tailwindcss"` world): the vendor ships a
//     BROWSER build that scans the DOM and generates utilities at runtime.
//     It is loaded from the same module host the import map already uses,
//     so no new host enters the content-security policy.
//   • Tailwind v3 (`@tailwind base;` + tailwind.config.js): its runtime CDN
//     is a different origin that the app's policy does not allow. Rather
//     than silently widening the app's CSP to style a preview, the
//     directives are stripped and the LIMIT is reported — custom themes are
//     not applied, and the pane says so instead of pretending.
//   • Sass/Less/Stylus/PostCSS: cannot be compiled without their toolchain.
//     Detected by NAME so the diagnostic is specific.
//
// Pure: package metadata and CSS text in, a plan out.
// ============================================================

import { PREVIEW_CDN, normalizeVersion } from "./module-resolution";
import type { PackageManifest } from "./module-resolution";

export interface CssToolchain {
  tailwind: { major: number; version: string | null } | null;
  sass: boolean;
  less: boolean;
  stylus: boolean;
  postcssPlugins: string[];
  /** Files that told us so, for the diagnostic */
  evidence: string[];
}

export interface CssPlan {
  /** Absolute script URLs to inject into the preview document */
  scripts: string[];
  /** Whether Tailwind's runtime build will style the page */
  runtimeTailwind: boolean;
  /** Directives removed from workspace CSS before bundling */
  stripVendorDirectives: boolean;
  diagnostics: Array<{ message: string; severity: "warning" }>;
}

const TAILWIND_V4_BROWSER_URL = `${PREVIEW_CDN}/@tailwindcss/browser@4`;

/** Reads the declared Tailwind major version, if Tailwind is present at all */
function tailwindVersion(manifest: PackageManifest): string | null {
  const ranges = [
    manifest.dependencies["tailwindcss"],
    manifest.devDependencies["tailwindcss"],
    manifest.dependencies["@tailwindcss/vite"],
    manifest.devDependencies["@tailwindcss/vite"],
    manifest.dependencies["@tailwindcss/postcss"],
    manifest.devDependencies["@tailwindcss/postcss"],
  ].filter((v): v is string => typeof v === "string");
  if (ranges.length === 0) return null;
  for (const range of ranges) {
    const version = normalizeVersion(range);
    if (version) return version;
  }
  // Present but versionless (workspace:, *, git) — still Tailwind.
  return "";
}

/**
 * Detects the CSS toolchain from package metadata plus the files the
 * workspace actually contains.
 */
export function detectCssToolchain(params: {
  manifest: PackageManifest;
  /** Config files present, by path (tailwind.config.*, postcss.config.*, …) */
  configPaths?: Iterable<string>;
  /** CSS/SCSS files with content, for directive + syntax evidence */
  cssFiles?: Iterable<{ path: string; content: string }>;
}): CssToolchain {
  const evidence: string[] = [];
  const configPaths = [...(params.configPaths ?? [])];
  const cssFiles = [...(params.cssFiles ?? [])];

  const declared = tailwindVersion(params.manifest);
  let tailwindMajor: number | null = null;
  if (declared !== null) {
    evidence.push("package.json declares tailwindcss");
    if (declared) {
      const major = Number.parseInt(declared.split(".")[0] ?? "", 10);
      if (Number.isFinite(major)) tailwindMajor = major;
    } else {
      // Declared without a usable version (workspace:, file:, a git ref).
      // Tailwind IS in use, but v3 and v4 class semantics differ, so
      // guessing a compiler would restyle the app incorrectly. 0 means
      // "present, unknown version" and the plan refuses to pick.
      tailwindMajor = 0;
    }
  }
  // v4 directives are unmistakable in the CSS itself.
  for (const file of cssFiles) {
    if (/(^|\n)\s*@import\s+["']tailwindcss["']/.test(file.content)) {
      tailwindMajor = tailwindMajor ?? 4;
      evidence.push(`${file.path} uses \`@import "tailwindcss"\``);
    }
    if (/(^|\n)\s*@tailwind\s+/.test(file.content)) {
      tailwindMajor = tailwindMajor ?? 3;
      evidence.push(`${file.path} uses \`@tailwind\` directives`);
    }
  }
  for (const path of configPaths) {
    if (/^tailwind\.config\.(t|j|c|m)s$/.test(path)) {
      tailwindMajor = tailwindMajor ?? 3;
      evidence.push(`${path} exists`);
    }
  }

  const has = (name: string) =>
    Boolean(params.manifest.dependencies[name] ?? params.manifest.devDependencies[name]);

  return {
    tailwind: tailwindMajor === null ? null : { major: tailwindMajor, version: declared || null },
    sass: has("sass") || has("node-sass") || cssFiles.some((f) => f.path.endsWith(".scss")),
    less: has("less") || cssFiles.some((f) => f.path.endsWith(".less")),
    stylus: has("stylus") || cssFiles.some((f) => f.path.endsWith(".styl")),
    postcssPlugins: [
      ...(has("postcss") ? ["postcss"] : []),
      ...(has("autoprefixer") ? ["autoprefixer"] : []),
      ...(has("postcss-preset-env") ? ["postcss-preset-env"] : []),
      ...(has("postcss-nested") ? ["postcss-nested"] : []),
    ],
    evidence,
  };
}

/** Decides what the preview will and will not do for this toolchain */
export function planCss(toolchain: CssToolchain): CssPlan {
  const scripts: string[] = [];
  const diagnostics: CssPlan["diagnostics"] = [];
  let runtimeTailwind = false;

  if (toolchain.tailwind) {
    if (toolchain.tailwind.major >= 4) {
      scripts.push(TAILWIND_V4_BROWSER_URL);
      runtimeTailwind = true;
      diagnostics.push({
        message:
          "Tailwind v4 detected: utilities are generated at runtime in the preview by Tailwind's browser build. A custom @theme block in your CSS is applied; values injected from a build plugin are not.",
        severity: "warning",
      });
    } else if (toolchain.tailwind.major === 0) {
      diagnostics.push({
        message:
          "Tailwind is a dependency but its version could not be determined, so the preview runs no Tailwind compiler and utilities are missing. Pin a version in package.json or use a lockfile in the repository to have the preview compile them.",
        severity: "warning",
      });
    } else {
      diagnostics.push({
        message:
          "Tailwind v3 detected: the preview strips `@tailwind` directives but does not run Tailwind 3's compiler, so utilities are missing and a tailwind.config.js theme is NOT applied. Styling in the preview will not match a real build.",
        severity: "warning",
      });
    }
  }

  const preprocessors = [
    toolchain.sass ? "Sass/SCSS" : null,
    toolchain.less ? "Less" : null,
    toolchain.stylus ? "Stylus" : null,
  ].filter((v): v is string => v !== null);
  if (preprocessors.length > 0) {
    diagnostics.push({
      message: `${preprocessors.join(", ")} in use: the preview cannot compile these, so their styles are absent. Plain CSS still applies.`,
      severity: "warning",
    });
  }
  if (toolchain.postcssPlugins.length > 0 && !toolchain.tailwind) {
    diagnostics.push({
      message: `PostCSS plugins are not run in the preview (${toolchain.postcssPlugins.join(", ")}), so their transformations are missing.`,
      severity: "warning",
    });
  }

  return {
    scripts,
    runtimeTailwind,
    stripVendorDirectives: toolchain.tailwind !== null,
    diagnostics,
  };
}

/**
 * Removes directives esbuild cannot resolve and the browser cannot use,
 * returning the CSS that is safe to bundle plus what was removed (so the
 * caller can report it rather than lose it silently).
 *
 * Only bare `@import` specifiers and Tailwind's directives are touched: a
 * relative `@import "./tokens.css"` is a real file in the workspace and is
 * left for the bundler.
 */
export function stripVendorCss(
  css: string,
  plan: CssPlan
): { css: string; stripped: string[] } {
  const stripped: string[] = [];
  let out = css;

  // @tailwind base; / @tailwind components; / @tailwind utilities;
  if (plan.stripVendorDirectives) {
    out = out.replace(/(^|\n)[ \t]*@tailwind[ \t]+[a-z-]+[ \t]*;[ \t]*(?=\n|$)/g, (_m, lead: string) => {
      stripped.push("@tailwind");
      return lead;
    });
  }

  // Bare @import "pkg" / @import "pkg/sub.css" — the browser has no way to
  // fetch these (there is no node_modules), and esbuild would fail on them.
  out = out.replace(
    /(^|\n)([ \t]*)@import\s+(?:url\(\s*)?["']([^"'\n]+)["']\s*\)?\s*([^;\n]*);?/g,
    (match: string, lead: string, indent: string, specifier: string, media: string) => {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
      if (isRelative) return match;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return match; // real URL, leave it
      stripped.push(specifier);
      // The note deliberately does not restate the directive verbatim: a
      // comment containing the text it replaced defeats every grep that
      // goes looking for leftovers.
      return `${lead}${indent}/* preview: bare package import of "${specifier}" removed${media.trim() ? ` (media: ${media.trim()})` : ""} — the browser has no package resolution */`;
    }
  );

  return { css: out, stripped };
}
