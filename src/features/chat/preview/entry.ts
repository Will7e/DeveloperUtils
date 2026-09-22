// ============================================================
// Preview Entry Detection — Which File Is The App?
// ============================================================
// Deciding an entry is the difference between "the preview runs your
// project" and "No preview entry found". The version this replaced was a
// fixed list of three HTML names and fifteen JS names, with a regex that
// took the FIRST `src=` attribute it could find. That failed on:
//
//   • a monorepo            (`apps/web/index.html`)
//   • Vite with root: "src" (`src/index.html`)
//   • a page whose real entry is a `type="module"` script listed AFTER a
//     plain `<script src="/analytics.js">` — the analytics file got bundled
//     as the app, and the preview ran the wrong program
//   • `public/index.html`, which the old list checked SECOND even though a
//     project with both `index.html` and `public/index.html` means the
//     former is the source of the latter
//
// So: honour the configured root, prefer module scripts, and search the
// whole tree by depth. Pure — it reads a workspace snapshot and returns a
// decision, which is why the rules below can be tested directly.
// ============================================================

import type { WorkspaceState } from "../types";
import { parsePackageJson } from "./module-resolution";

/** Conventional HTML entry names, in the order they should win */
export const HTML_ENTRIES = ["index.html", "public/index.html", "preview.html"];

/** Conventional JS/TS entry paths, most specific first */
export const JS_ENTRIES = [
  "src/main.tsx",
  "src/main.jsx",
  "src/index.tsx",
  "src/index.jsx",
  "main.tsx",
  "index.tsx",
  "main.jsx",
  "index.jsx",
  "src/main.ts",
  "src/index.ts",
  "main.ts",
  "index.ts",
  "src/main.js",
  "src/index.js",
  "main.js",
  "index.js",
];

export type EntryKind = "html" | "js";

export interface DetectedEntry {
  kind: EntryKind;
  path: string;
  /** For HTML entries: the script src it references (if any) */
  scriptSrc?: string;
}

/**
 * Frameworks whose entry is NOT an HTML file plus a script tag. They need
 * a server (SSR, routing, API routes, a compiler), so the honest answer is
 * to name the framework rather than report "no entry found" — which reads
 * as "your repository is empty" when it is not.
 */
const UNSUPPORTED_FRAMEWORKS: Array<{
  match: (deps: string[], files: string[]) => boolean;
  name: string;
  why: string;
}> = [
  {
    match: (deps, files) => deps.includes("next") || files.some((f) => /^next\.config\./.test(f)),
    name: "Next.js",
    why: "its pages/app routes are rendered by a Node server, which a browser sandbox cannot run",
  },
  {
    match: (deps, files) => deps.includes("nuxt") || files.some((f) => /^nuxt\.config\./.test(f)),
    name: "Nuxt",
    why: "it needs a Vite/Nitro server build before anything can be rendered",
  },
  {
    match: (deps) => deps.includes("@sveltejs/kit") || deps.includes("@angular/core"),
    name: "a framework with its own compiler",
    why: "its components need a build step the preview does not run",
  },
  {
    match: (deps) => deps.includes("astro"),
    name: "Astro",
    why: "its pages are compiled server-side at build time",
  },
];

/**
 * Names the reason a project cannot be previewed, when it cannot.
 * Returns null when the project is merely unfamiliar.
 */
export function unsupportedProjectReason(ws: WorkspaceState): string | null {
  const manifest = parsePackageJson(ws.files["package.json"]?.content ?? null);
  const deps = [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.devDependencies),
  ];
  const files = ws.tree.map((e) => e.path);
  for (const candidate of UNSUPPORTED_FRAMEWORKS) {
    if (candidate.match(deps, files)) {
      return `This looks like ${candidate.name}: ${candidate.why}. The preview runs a single bundled browser app, so this project cannot be rendered here.`;
    }
  }
  return null;
}

/**
 * Finds the entry document/script.
 *
 * `root` comes from a Vite config when the project sets one, so
 * `root: "src"` finds `src/index.html` instead of declaring the project
 * empty.
 */
export function detectEntry(
  ws: WorkspaceState,
  options: { root?: string | null } = {}
): DetectedEntry | null {
  const paths = new Set(ws.tree.map((e) => e.path));
  const has = (p: string) => paths.has(p) || ws.files[p] !== undefined;
  const root = options.root ? options.root.replace(/^\/+|\/+$/g, "") : "";
  const inRoot = (p: string) =>
    root && !root.startsWith("..") && root !== "." ? `${root}/${p}` : p;

  // 1. The conventional HTML names, relative to the configured root.
  for (const html of HTML_ENTRIES) {
    const candidate = inRoot(html);
    if (has(candidate)) {
      return { kind: "html", path: candidate, scriptSrc: entryScriptOf(ws, candidate) };
    }
  }
  // The root may be configured but not exist yet in the tree; fall back to
  // the repository root rather than giving up.
  if (root && root !== ".") {
    for (const html of HTML_ENTRIES) {
      if (has(html)) return { kind: "html", path: html, scriptSrc: entryScriptOf(ws, html) };
    }
  }

  // 2. Any index.html in the tree, shallowest first — monorepos and nested
  //    app folders. A deep match is still better than none.
  const htmlCandidates = [...paths]
    .filter((p) => /(^|\/)index\.html$/i.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const firstHtml = htmlCandidates[0];
  if (firstHtml) {
    return { kind: "html", path: firstHtml, scriptSrc: entryScriptOf(ws, firstHtml) };
  }

  // 3. A JS/TS entry, also relative to the configured root first.
  for (const js of JS_ENTRIES) {
    const candidate = inRoot(js);
    if (has(candidate)) return { kind: "js", path: candidate };
  }
  return null;
}

/**
 * The script an HTML entry actually loads.
 *
 * A `type="module"` script wins over every other, because that is the one
 * a bundler built for the page; a second plain script must not shadow it.
 * The attribute regex also works when `src` comes before or after `type`.
 */
function entryScriptOf(ws: WorkspaceState, htmlPath: string): string | undefined {
  const content = ws.files[htmlPath]?.content ?? "";
  if (!content) return undefined;
  const scripts: Array<{ src: string; isModule: boolean }> = [];
  const tagRe = /<script\b([^>]*)>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagRe.exec(content)) !== null) {
    const attrs = tag[1] ?? "";
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    if (/^(https?:|data:|blob:|\/\/)/i.test(src)) continue;
    scripts.push({ src, isModule: /\btype\s*=\s*["']module["']/i.test(attrs) });
  }
  const moduleScript = scripts.find((s) => s.isModule);
  return (moduleScript ?? scripts[0])?.src;
}
