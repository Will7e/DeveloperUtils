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

/**
 * A script src read as a workspace path, or null when it is not one.
 *
 * `src="/src/main.jsx"` is the standard Vite entry, and its leading slash
 * is a URL fact rather than a path fact: it means "from the project root".
 * Handing that string to the bundler unchanged is how a build came to fail
 * on its OWN entry point — "`/src/main.jsx` is in the repository but its
 * contents were not loaded" — because the preloader had already stripped the
 * slash when it fetched the file. Two callers, two readings of one attribute.
 *
 * A query or hash is dropped for the same reason: `?v=2` names a cache key,
 * not a file.
 */
export function workspaceEntryPath(scriptSrc: string | undefined): string | null {
  if (!scriptSrc) return null;
  const raw = scriptSrc.trim().split(/[?#]/)[0] ?? "";
  if (!raw || /^(https?:|data:|blob:|mailto:|\/\/)/i.test(raw)) return null;
  const stripped = raw.replace(/^\.?\/+/, "");
  return stripped.length > 0 ? stripped : null;
}

/**
 * The workspace file an HTML entry's script actually is.
 *
 * Two shapes have to resolve, and both are ordinary:
 *
 *   • `index.html` with `src="/src/main.tsx"` — root-relative, the Vite
 *     convention, and root-relative to the REPOSITORY here because a build's
 *     root is the repository unless a vite config says otherwise;
 *   • `apps/web/index.html` with the same `src` — a monorepo, where that URL
 *     means `apps/web/src/main.jsx` on disk.
 *
 * So the repository-root reading is tried first, then the document-relative
 * one, and only then is the file reported missing. Extension candidates come
 * from the VFS (so `/src/main` finds `src/main.jsx`): an HTML attribute is
 * allowed to omit the extension.
 */
export function resolveEntryScriptPath(params: {
  htmlPath: string;
  scriptSrc: string | undefined;
  exists: (path: string) => boolean;
  resolveRel: (from: string, rel: string) => string | null;
}): string | null {
  const { htmlPath, scriptSrc, exists, resolveRel } = params;
  const stripped = workspaceEntryPath(scriptSrc);
  if (!stripped) return null;

  // 1. From the repository root — what a leading slash means in HTML.
  const fromRoot = resolveRel(htmlPath, `/${stripped}`);
  if (fromRoot) return fromRoot;
  if (exists(stripped)) return stripped;

  // 2. From the document's own directory — a monorepo, or a relative src
  //    (`./main.jsx`, `../shared/app.js`).
  return resolveRel(htmlPath, `./${stripped}`);
}
