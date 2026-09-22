// ============================================================
// Preview VFS — Workspace-Backed Virtual File System
// ============================================================
// esbuild resolves imports through this: a path that exists in the
// repo tree or in the working copy is a vfs module, everything else
// is external (bare imports ride the import map). Pure — it reads a
// WorkspaceState and never mutates it.
//
// Lives in its own module because two callers need the same
// resolution rules: the bundler (lib/preview-runtime) and the
// preloader that fetches a repo's files before bundling.

import type { WorkspaceState } from "../types";

export interface VFS {
  read(path: string): string | null;
  exists(path: string): boolean;
  resolveRel(from: string, rel: string): string | null;
  /** Every file path in the workspace — what a glob pattern matches against */
  paths(): string[];
}

/** Builds a virtual FS over a workspace snapshot */
export function createWorkspaceVfs(ws: WorkspaceState): VFS {
  const allPaths = new Set<string>(
    ws.tree.filter((e) => e.type === "blob").map((e) => e.path)
  );

  // A locally deleted file is absent even though the repo tree still
  // lists it — otherwise the bundler would resolve an import into a
  // tombstone and fail on unloaded content.
  const hasAny = (p: string): boolean => {
    const file = ws.files[p];
    if (file) return file.status !== "deleted";
    return allPaths.has(p);
  };

  const read = (path: string): string | null => {
    const f = ws.files[path];
    if (f && f.status !== "deleted") return f.content;
    return null; // contents not loaded → resolution failure, surfaced as a diagnostic
  };

  /** Adds extension candidates like ./Button → ./Button.tsx */
  function candidates(p: string): string[] {
    if (/\.(tsx?|jsx?|css|json|svg|png|jpg|jpeg|gif|webp)$/.test(p)) return [p];
    return [
      p,
      `${p}.ts`,
      `${p}.tsx`,
      `${p}.js`,
      `${p}.jsx`,
      `${p}.css`,
      `${p}/index.ts`,
      `${p}/index.tsx`,
      `${p}/index.js`,
      `${p}/index.jsx`,
    ];
  }

  return {
    read,
    exists: hasAny,
    paths: () => [...allPaths],
    resolveRel: (from, rel) => {
      if (rel.startsWith("/")) {
        const p = rel.slice(1);
        return candidates(p).find(hasAny) ?? null;
      }
      const dirParts = from.split("/").slice(0, -1);
      const relParts = rel.split("/");
      const stack = [...dirParts];
      for (const part of relParts) {
        if (part === "." || part === "") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      const joined = stack.join("/");
      return candidates(joined).find(hasAny) ?? null;
    },
  };
}

// ── Local import scanning (preload discovery) ────────────────

/** Specifiers that name a file in this repo (vs an npm package) */
function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

// NOTE: the clause characters are deliberately restricted to
// letters, punctuation and whitespace — never quotes. An
// over-permissive `[\s\S]*?` between `import` and `from` skips past
// a quote and lands on the NEXT statement's specifier, silently
// losing the side-effect import it skipped over.
const JS_IMPORT_PATTERNS = [
  // import x / * as x / { a, b } / type { T } from "y"  (multi-line safe)
  /\bimport\s+[\w*{},\s$]*?from\s*["']([^"'\n]+)["']/g,
  // import "y"  (side effect)
  /\bimport\s*["']([^"'\n]+)["']/g,
  // export * from "y" / export { a } from "y"
  /\bexport\s+(?:\*|\{[\s\S]*?\})\s*from\s*["']([^"'\n]+)["']/g,
  // import("y")
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  // require("y")
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

const CSS_IMPORT_PATTERNS = [
  /@import\s+(?:url\(\s*)?["']([^"'\n]+)["']/g,
  /@import\s+url\(\s*([^"')\s]+)\s*\)/g,
];

/**
 * EVERY import specifier found in one file — relative, absolute and bare.
 * Static, dynamic, re-export and require forms are covered, plus CSS
 * @import.
 *
 * This is a scanner, not a parser: it only needs to over-approximate the
 * dependency graph, since the preloader fetches what exists and skips what
 * does not.
 *
 * It is the single source of specifier detection for three callers that
 * must agree: the preloader (which local files to fetch), the alias-aware
 * resolver (which specifiers are path aliases, not packages), and the
 * module-resolution reporter (which bare specifiers need an import map
 * entry). Duplicating the patterns is how those three drift apart, and a
 * drift there is a silently blank preview.
 */
export function importSpecifiers(content: string, path: string): string[] {
  const patterns = path.toLowerCase().endsWith(".css")
    ? CSS_IMPORT_PATTERNS
    : JS_IMPORT_PATTERNS;
  const out: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1]?.trim();
      if (!spec) continue;
      if (!out.includes(spec)) out.push(spec);
    }
  }
  return out;
}

/**
 * Local (repo-relative) import specifiers found in one file. Bare
 * specifiers (npm packages) and URLs are dropped — the bundler
 * externalizes those rather than loading them from the repo.
 */
export function localImportSpecifiers(content: string, path: string): string[] {
  return importSpecifiers(content, path).filter(isLocalSpecifier);
}
