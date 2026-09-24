// ============================================================
// Path Glob — Matching A Filename Pattern, Not A Regex
// ============================================================
// "Find the test files" and "find the file that mentions X" are different
// questions, and until now this agent could only answer the second one. A tree
// listing answers neither when the project is large: `list_repo_files` returns
// paths, not answers, and it is capped.
//
// Globs are the vocabulary people already use for the first question, so this
// module implements the subset that matters (`*`, `**`, `?`, `{a,b}`) with the
// one rule that makes a pattern behave the way a user expects: A PATTERN WITH
// NO SLASH MATCHES A FILENAME AT ANY DEPTH. `*.test.ts` finds
// `src/features/chat/lib/skills.test.ts`; `src/*.test.ts` deliberately does
// not, because the user asked about that one directory.
//
// Pure and dependency-free, so the matching rules are unit-tested rather than
// discovered by watching a tool call.

/** Options for {@link globToRegExp} */
export interface GlobOptions {
  /** Off makes matching case-insensitive (paths are case-sensitive by default) */
  caseSensitive?: boolean;
}

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compiles a glob into a regular expression over a full path.
 *
 * Supported syntax: `**` (any characters, including `/`), `*` (any characters
 * except `/`), `?` (one character except `/`), and `{a,b}` alternation. A
 * leading `./` is ignored, and a trailing `/` is dropped so a directory-shaped
 * pattern behaves like its contents.
 */
export function globToRegExp(glob: string, options: GlobOptions = {}): RegExp {
  const caseSensitive = options.caseSensitive ?? true;
  const pattern = glob.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const anchoredAtAnyDepth = !pattern.includes("/");

  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        // `**/` also matches ZERO directories (`src/**/a.ts` matches src/a.ts).
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        source += `(?:${alternatives.join("|")})`;
        i = close;
        continue;
      }
    }
    source += escapeRegExpChar(ch);
  }

  const prefix = anchoredAtAnyDepth ? "(?:.*/)?" : "";
  return new RegExp(`^${prefix}${source}$`, caseSensitive ? "" : "i");
}

/**
 * True when a repo-relative path matches the pattern.
 *
 * `matchesGlob("src/a.test.ts", "*.test.ts")` is true (depth is not implied by
 * a pattern without a slash); `matchesGlob("src/a.ts", "src/*.ts")` is true and
 * `src/nested/a.ts` is not.
 */
export function matchesGlob(path: string, glob: string, options: GlobOptions = {}): boolean {
  if (!glob.trim()) return false;
  return globToRegExp(glob, options).test(path.replace(/^\.\//, ""));
}

/**
 * True when a path is inside a directory (or IS the directory's own prefix).
 * Used to scope a search before matching, so a subtree narrows the candidate
 * set instead of being part of the pattern.
 */
export function isWithinSubtree(path: string, subtree: string): boolean {
  const prefix = subtree.trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}
