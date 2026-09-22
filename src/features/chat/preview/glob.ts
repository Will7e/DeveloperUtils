// ============================================================
// Preview Glob — Vite's import.meta.glob, Rewritten at Build Time
// ============================================================
// `import.meta.glob("./pages/*.{jsx,tsx}")` is a VITE api, not a browser
// one: Vite replaces the call with a static map of imports while building.
// A preview that leaves the call alone does not degrade gracefully — the
// module reaches the browser, `import.meta` is an ordinary (empty) object,
// and the app dies with
//
//   Uncaught TypeError: (intermediate value).glob is not a function
//
// which names neither the file nor the API. An app that auto-discovers its
// routes or its plugins is dead on load, before anything renders, and the
// pane shows the same black rectangle as a document with nothing in it.
//
// So the call is rewritten here, at build time, exactly as Vite does:
//
//   import.meta.glob("./pages/*.jsx")
//     → { "./pages/Home.jsx": () => import("./pages/Home.jsx"), … }
//   import.meta.glob("./pages/*.jsx", { eager: true })
//     → a static import per file, and a map of its namespace
//   import.meta.glob("./notes/*.md", { eager: true, as: "raw" })
//     → a map of the files' TEXT, taken from the workspace
//
// Keys are the paths as the app would write them — relative to the file
// doing the globbing, `./`-prefixed — because that is what the app looks up
// (`modules["./pages/Home.jsx"]`). Getting that wrong yields a map with the
// right values under keys nothing can find.
//
// Anything that cannot be rewritten (a pattern built from a variable, a
// `query` option) is reported with the file and the pattern rather than left
// to explode at runtime.
//
// Pure: text in, text out, plus the workspace's paths and contents.
// ============================================================

export interface GlobTransformOptions {
  code: string;
  /** Workspace path of the file containing the calls */
  importer: string;
  /** Every blob path in the workspace (what a pattern is matched against) */
  paths: string[];
  /** Reads a workspace file's text, for `as: "raw"` */
  read: (path: string) => string | null;
}

export interface GlobTransformResult {
  code: string;
  /** Patterns that were rewritten, for diagnostics */
  rewritten: string[];
  /** Calls left alone, with the reason — these fail at runtime, so say why now */
  unsupported: Array<{ pattern: string; reason: string }>;
}

/** Escapes everything a regex treats specially, for literal glob characters */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles one glob into a regex.
 *
 * Supports what code in the wild actually uses: `*` (within a segment), `**`
 * (across segments, including zero), `?`, `{a,b}` alternation, and `[abc]`
 * character classes.
 *
 * The double-star-then-slash case is the one worth naming: it must match ZERO
 * directories as well, or a pattern of `**` plus `*.js` would miss the file
 * sitting next to the importer — the single most common shape there is.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += escapeRegExp(ch);
      } else {
        const body = pattern.slice(i + 1, end);
        out += `(?:${body.split(",").map(escapeRegExp).join("|")})`;
        i = end;
      }
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        out += escapeRegExp(ch);
      } else {
        const body = pattern.slice(i + 1, end);
        // `[!a]` is glob negation; regex spells it `[^a]`.
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

/** Matches one path against one glob (no negation — see resolveGlobPatterns) */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/** Normalizes `a/b/../c`, so a pattern can be matched against tree paths */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** The directory part of a workspace path ("" at the root) */
function dirOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/**
 * A pattern as tree paths, or null when it is not a literal relative glob.
 * Vite requires patterns to be relative (`./`, `../`) or rooted (`/`); a bare
 * `**\/*.js` is ambiguous, so it is reported rather than guessed at.
 */
function treePatternOf(pattern: string, importer: string): string | null {
  if (pattern.startsWith("/")) return normalizePath(pattern);
  if (!pattern.startsWith("./") && !pattern.startsWith("../")) return null;
  return normalizePath(`${dirOf(importer)}/${pattern}`);
}

/** The key the app looks a module up by: relative to the importer, `./`-prefixed */
function keyFor(path: string, importer: string): string {
  const from = dirOf(importer);
  const fromParts = from === "" ? [] : from.split("/");
  const targetParts = path.split("/");
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < targetParts.length &&
    fromParts[shared] === targetParts[shared]
  ) {
    shared++;
  }
  const up = fromParts.slice(shared).map(() => "..");
  const down = targetParts.slice(shared);
  const relative = [...up, ...down].join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** The paths a set of patterns selects, in tree order, deduplicated */
export function selectGlobPaths(
  patterns: string[],
  importer: string,
  paths: string[]
): { matches: string[]; invalid: string[] } {
  const treePatterns: Array<{ glob: string; negated: boolean }> = [];
  const invalid: string[] = [];
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const tree = treePatternOf(body, importer);
    if (tree === null) {
      invalid.push(pattern);
      continue;
    }
    treePatterns.push({ glob: tree, negated });
  }

  const positives = treePatterns.filter((p) => !p.negated);
  const negatives = treePatterns.filter((p) => p.negated);
  const matches = paths
    .filter((path) => positives.some((p) => matchGlob(p.glob, path)))
    .filter((path) => !negatives.some((p) => matchGlob(p.glob, path)))
    .sort();
  return { matches, invalid };
}

// ── Reading the call out of the source ───────────────────────

interface GlobCall {
  /** Index of the `i` in `import.meta.glob` */
  start: number;
  /** Index just past the closing `)` */
  end: number;
  /** Text of the argument list */
  args: string;
  /** True for the legacy `import.meta.globEager` spelling */
  legacyEager: boolean;
}

/**
 * Finds `import.meta.glob(...)` calls, skipping strings and comments.
 *
 * A scanner rather than a regex because the argument list can contain nested
 * parentheses, arrays and template literals (`import.meta.glob(\`./x/${name}\`)`
 * is real code), and because `"import.meta.glob("` inside a string is not a
 * call.
 */
export function findGlobCalls(code: string): GlobCall[] {
  const calls: GlobCall[] = [];
  const marker = "import.meta.glob";
  let i = 0;

  while (i < code.length) {
    const ch = code[i]!;

    // Skip string literals and template literals (with their escapes).
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Skip comments.
    if (ch === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      i = close === -1 ? code.length : close + 2;
      continue;
    }

    if (!code.startsWith(marker, i)) {
      i++;
      continue;
    }

    const legacyEager = code.startsWith(`${marker}Eager`, i);
    const afterMarker = i + marker.length + (legacyEager ? "Eager".length : 0);
    // `import.meta.globEager`/`import.meta.glob` must be followed by `(`, and
    // must not be the tail of a longer identifier (`myimport.meta.glob`).
    if (code[afterMarker] !== "(") {
      i = afterMarker;
      continue;
    }
    const prev = code[i - 1];
    if (prev !== undefined && /[\w$.]/.test(prev)) {
      i = afterMarker;
      continue;
    }

    const argsStart = afterMarker + 1;
    let depth = 1;
    let j = argsStart;
    while (j < code.length && depth > 0) {
      const c = code[j]!;
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        j++;
        while (j < code.length && code[j] !== quote) {
          if (code[j] === "\\") j++;
          j++;
        }
        j++;
        continue;
      }
      if (c === "/" && code[j + 1] === "/") {
        while (j < code.length && code[j] !== "\n") j++;
        continue;
      }
      if (c === "/" && code[j + 1] === "*") {
        const close = code.indexOf("*/", j + 2);
        j = close === -1 ? code.length : close + 2;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      j++;
    }
    const argsEnd = depth === 0 ? j - 1 : code.length;
    calls.push({
      start: i,
      end: Math.min(argsEnd + 1, code.length),
      args: code.slice(argsStart, argsEnd),
      legacyEager,
    });
    i = argsEnd + 1;
  }

  return calls;
}

/** Splits an argument list on its top-level commas */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < args.length && args[i] !== quote) {
        if (args[i] === "\\") {
          current += args[i]!;
          i++;
        }
        current += args[i]!;
        i++;
      }
      current += quote;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** A string literal's value, or null when the argument is not a literal */
function stringLiteralOf(argument: string): string | null {
  const trimmed = argument.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || trimmed[trimmed.length - 1] !== quote) {
    return null;
  }
  const body = trimmed.slice(1, -1);
  // A template literal with a substitution is not a static pattern.
  if (quote === "`" && body.includes("${")) return null;
  return body.replace(/\\(.)/g, "$1");
}

/** The patterns a glob call asks for: one literal, or an array of literals */
function patternsOf(argument: string): { patterns: string[]; literal: boolean } {
  const array = /^\[([\s\S]*)\]$/.exec(argument.trim());
  const items = array ? splitArguments(array[1] as string) : [argument];
  const patterns: string[] = [];
  for (const item of items) {
    const value = stringLiteralOf(item);
    if (value === null) return { patterns: [], literal: false };
    patterns.push(value);
  }
  return { patterns, literal: true };
}

/**
 * Rewrites every `import.meta.glob` call in one file.
 *
 * Returns the code untouched when there is nothing to rewrite, so callers can
 * hand it any source without a string comparison of their own.
 */
export function transformImportMetaGlob(options: GlobTransformOptions): GlobTransformResult {
  const { code, importer, paths, read } = options;
  const calls = findGlobCalls(code);
  if (calls.length === 0) return { code, rewritten: [], unsupported: [] };

  const rewritten: string[] = [];
  const unsupported: Array<{ pattern: string; reason: string }> = [];
  /** Static imports generated for eager maps, prepended to the module */
  const generatedImports: string[] = [];
  let nextImportId = 0;
  let out = "";
  let cursor = 0;

  for (const call of calls) {
    const [patternArg = "", optionsArg = ""] = splitArguments(call.args);
    const { patterns, literal } = patternsOf(patternArg);
    const rawCall = code.slice(call.start, call.end);
    const emit = (replacement: string | null) => {
      out += code.slice(cursor, call.start);
      out += replacement ?? rawCall;
      cursor = call.end;
    };

    if (!literal || patterns.length === 0) {
      unsupported.push({
        pattern: patternArg.trim() || rawCall,
        reason: "the pattern is computed, not a string literal, so it cannot be resolved while building",
      });
      emit(null);
      continue;
    }
    if (/\bquery\s*:/.test(optionsArg)) {
      unsupported.push({
        pattern: patterns.join(", "),
        reason: "the `query` option is not supported by the preview",
      });
      emit(null);
      continue;
    }

    const eager = call.legacyEager || /\beager\s*:\s*true\b/.test(optionsArg);
    const asRaw = /\bas\s*:\s*["']raw["']/.test(optionsArg);
    const namedImport = /\bimport\s*:\s*["']([^"']+)["']/.exec(optionsArg)?.[1];
    if (/\bas\s*:\s*["']url["']/.test(optionsArg)) {
      // A URL form would need a served copy of the file, which the preview
      // has no way to hand out — saying so beats a map of undefined.
      unsupported.push({
        pattern: patterns.join(", "),
        reason: '`as: "url"` is not supported by the preview',
      });
      emit(null);
      continue;
    }

    const { matches, invalid } = selectGlobPaths(patterns, importer, paths);
    if (invalid.length > 0) {
      unsupported.push({
        pattern: invalid.join(", "),
        reason: "a glob pattern must be relative (./ or ../) or rooted at /",
      });
    }
    if (matches.length === 0) {
      // Vite answers an unmatched glob with an empty object, so the app can
      // still run: a missing directory is not a build failure.
      emit("({})");
      rewritten.push(...patterns);
      continue;
    }

    const entries: string[] = [];
    let failed = false;
    for (const path of matches) {
      const key = keyFor(path, importer);
      const specifier = key;
      if (eager && asRaw) {
        const content = read(path);
        if (content === null) {
          unsupported.push({
            pattern: patterns.join(", "),
            reason: `\`${path}\` has not been loaded, so its text cannot be inlined`,
          });
          failed = true;
          break;
        }
        entries.push(`${JSON.stringify(key)}: ${JSON.stringify(content)}`);
        continue;
      }
      if (eager) {
        const id = `__intab_glob_${nextImportId++}`;
        generatedImports.push(`import * as ${id} from ${JSON.stringify(specifier)};`);
        entries.push(`${JSON.stringify(key)}: ${namedImport ? `${id}[${JSON.stringify(namedImport)}]` : id}`);
        continue;
      }
      const importerCall = asRaw
        ? `import(${JSON.stringify(`${specifier}?raw`)}).then((m) => m.default)`
        : namedImport
          ? `import(${JSON.stringify(specifier)}).then((m) => m[${JSON.stringify(namedImport)}])`
          : `import(${JSON.stringify(specifier)})`;
      entries.push(`${JSON.stringify(key)}: () => ${importerCall}`);
    }

    if (failed) {
      emit(null);
      continue;
    }

    emit(`({ ${entries.join(", ")} })`);
    rewritten.push(...patterns);
  }

  out += code.slice(cursor);
  return {
    code: generatedImports.length > 0 ? `${generatedImports.join("\n")}\n${out}` : out,
    rewritten,
    unsupported,
  };
}
