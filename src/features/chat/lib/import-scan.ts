// ============================================================
// Import Scan — Which Specifiers Does This File Name
// ============================================================
// One job: given a file's text and path, list every module specifier it
// imports, and classify a bare one into a package and a subpath.
//
// The type check needs this and nothing else from it. A `tsc` run in a
// worker has no node_modules, so every bare import the workspace makes is a
// module it cannot resolve — and the check would drown in "cannot find
// module 'react'" instead of reporting the type error the agent actually
// wrote. The fix is to declare the packages the code imports, and that means
// enumerating them, which means reading the imports.
//
// The patterns are deliberately narrow (see the note below) and live in ONE
// place: a second, subtly different reader of imports is how two answers
// drift. Nothing here touches the network, the store or a bundler: it is text
// in, strings out, which is what makes it directly testable.

/** Splits a bare specifier into package name and subpath. */
export function splitBareSpecifier(
  specifier: string
): { pkg: string; subpath: string } | null {
  const raw = specifier.split("?")[0]?.split("#")[0]?.trim() ?? "";
  if (!raw) return null;
  // Relative, absolute, and protocol/URL forms are not packages.
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

/** Specifiers that exist only in Node and can never be a browser module */
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

// NOTE: the clause characters are deliberately restricted to letters,
// punctuation and whitespace — never quotes. An over-permissive `[\s\S]*?`
// between `import` and `from` skips past a quote and lands on the NEXT
// statement's specifier, silently losing the side-effect import it skipped
// over.
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
 * `@import`.
 *
 * This is a scanner, not a parser: it only needs to over-approximate the
 * dependency graph, since the caller declares what exists and skips what
 * does not.
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
