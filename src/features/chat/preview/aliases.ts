// ============================================================
// Preview Path Aliases — tsconfig `paths` + Vite `resolve.alias`
// ============================================================
// Vite/Next/CRA TypeScript projects overwhelmingly import through an
// alias: `@/lib/utils` in this repository, `~/`, `src/`, `@components/`
// elsewhere. The preview's resolver knew only relative and absolute
// paths, so an aliased specifier was classified as a BARE PACKAGE, marked
// external, and handed to the browser — which cannot resolve `@/lib/utils`
// and aborts the whole module graph. The pane went blank.
//
// So aliases are read from the two files that define them and applied
// BEFORE package classification. That order is the entire fix: resolve
// locally first, then fall through to the import map.
//
// Pure and clock-free. The only I/O-shaped input is an `exists` callback,
// which lets the tests drive a fake workspace and keeps this module free
// of the store.
// ============================================================

/** One alias rule: a prefix and where it points (repo-relative) */
export interface AliasRule {
  /** Prefix as written in imports, e.g. "@/" or "@" or "~/assets" */
  prefix: string;
  /** Replacement, repo-relative, no leading "./" (e.g. "src/") */
  target: string;
  /** Where the rule came from, for diagnostics */
  source: "tsconfig" | "vite";
}

export interface AliasConfig {
  rules: AliasRule[];
  /** Vite `root`, repo-relative — entry detection needs it too */
  root: string | null;
  /** True when an alias source existed but could not be read statically */
  unparsed: boolean;
  /** Paths that were considered, for the diagnostic message */
  read: string[];
}

// ── Comment stripping (tsconfig is JSONC, not JSON) ──────────

/**
 * Strips line and block comments plus trailing commas so a real tsconfig
 * parses. Quote-aware: it will not cut a comment marker that is inside a
 * string, which is the whole reason this is not a one-line regex.
 */
export function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // Trailing commas before a closing brace/bracket.
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Normalizes a configured path to a repo-relative prefix.
 *
 * Drops a leading `./`, climbs out of any `../` (a target outside the
 * repository cannot be served by the VFS, and `../../shared` must not
 * resolve to a path inside the wrong project), and removes the wildcard
 * a tsconfig target carries: `"./src/*"` is the directory `src/`, not a
 * literal path containing a star. Leaving that star in produced imports
 * with a wildcard segment in the middle, which matched nothing.
 */
export function normalizeTarget(value: string): string {
  let out = value.trim().replace(/^\.\//, "");
  while (out.startsWith("../")) out = out.slice(3);
  out = out.replace(/^\/+/, "");
  return out.replace(/\*+\/?/g, "");
}

// ── tsconfig ─────────────────────────────────────────────────

export interface TsconfigAliases {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

/** Reads `baseUrl` + `compilerOptions.paths` from a tsconfig/jsconfig */
export function parseTsconfigAliases(raw: string | null | undefined): TsconfigAliases {
  if (!raw || !raw.trim()) return { baseUrl: null, paths: {} };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
  } catch {
    return { baseUrl: null, paths: {} };
  }
  // `extends` is not followed: the base file is usually in the repo, but
  // chasing it here would mean a resolver with I/O and cycles. Readers are
  // asked for every tsconfig in the tree instead (see readAliasConfig).
  const compilerOptions =
    typeof parsed.compilerOptions === "object" && parsed.compilerOptions !== null
      ? (parsed.compilerOptions as Record<string, unknown>)
      : {};
  const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : null;
  const rawPaths =
    typeof compilerOptions.paths === "object" && compilerOptions.paths !== null
      ? (compilerOptions.paths as Record<string, unknown>)
      : {};

  const paths: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(rawPaths)) {
    if (!Array.isArray(targets)) continue;
    const list = targets.filter((t): t is string => typeof t === "string");
    if (list.length > 0) paths[pattern] = list;
  }
  return { baseUrl, paths };
}

// ── vite.config ──────────────────────────────────────────────

export interface ViteConfigAliases {
  alias: Record<string, string>;
  root: string | null;
  /** The alias block exists but was not statically readable */
  unparsed: boolean;
}

/**
 * Reads a STATIC `resolve.alias` object and `root` out of a vite config.
 *
 * Vite configs are JavaScript, so this is deliberately a narrow
 * extractor rather than an evaluator: it accepts string values and the
 * three literal path forms that cover virtually every real config
 * (`path.resolve(__dirname, "x")`, `fileURLToPath(new URL("x", import.meta.url))`,
 * and a bare relative string). Anything computed — a function, a loop, a
 * variable — sets `unparsed`, so the caller can say "aliases could not be
 * read from vite.config.ts" instead of quietly shipping a broken preview.
 */
export function parseViteConfigAliases(raw: string | null | undefined): ViteConfigAliases {
  if (!raw || !raw.trim()) return { alias: {}, root: null, unparsed: false };

  const rootMatch = /(?:^|[\s,{])root\s*:\s*(["'])([^"']+)\1/.exec(raw);
  const root = rootMatch ? normalizeTarget(rootMatch[2] as string) : null;

  const alias: Record<string, string> = {};
  const blockMatch = /alias\s*:\s*\{/.exec(raw);
  if (!blockMatch) {
    // `alias: someVariable` or a plugin-provided alias.
    if (/alias\s*:/.test(raw)) return { alias, root, unparsed: true };
    return { alias, root, unparsed: false };
  }

  // Take the balanced braces of the alias object, then read simple pairs.
  const start = blockMatch.index + blockMatch[0].length - 1;
  const body = sliceBalanced(raw, start);
  if (body === null) return { alias, root, unparsed: true };

  let matchedAny = false;
  for (const entry of parseAliasEntries(body)) {
    const target = literalPathFromExpression(entry.value);
    if (target === null) continue;
    matchedAny = true;
    alias[entry.key] = normalizeTarget(target);
  }

  // A block that parsed as an object but yielded nothing usable is not
  // trustworthy: say so rather than pretending the project has no aliases.
  const looksNonEmpty = body.replace(/[\s,]/g, "").length > 0;
  return { alias, root, unparsed: looksNonEmpty && !matchedAny };
}

/**
 * Reads `key: value` pairs out of an alias object.
 *
 * Deliberately depth-aware rather than a regex: the most common real
 * value in the wild is `path.resolve(__dirname, "./src")`, and a comma
 * inside those parentheses truncates any naive `[^,]+` capture — which is
 * exactly how this broke the first time, silently leaving a repository
 * with aliases that appeared to have none.
 */
function parseAliasEntries(body: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const n = body.length;
  let i = 0;

  while (i < n) {
    while (i < n && /[\s,]/.test(body[i] as string)) i++;
    if (i >= n) break;

    // Key: quoted, or everything up to the colon.
    let key: string;
    const quote = body[i] as string;
    if (quote === '"' || quote === "'") {
      const end = body.indexOf(quote, i + 1);
      if (end === -1) break;
      key = body.slice(i + 1, end);
      i = end + 1;
    } else {
      const start = i;
      while (i < n && body[i] !== ":") i++;
      key = body.slice(start, i).trim();
    }

    if (body[i] !== ":") {
      // Not a pair (a spread, a call, something computed) — resync at the
      // next comma and keep reading, so one odd entry cannot hide the rest.
      while (i < n && body[i] !== ",") i++;
      continue;
    }
    i++; // past the colon

    // Value: to the next comma at depth zero, honouring strings.
    let depth = 0;
    let inString: string | null = null;
    let value = "";
    for (; i < n; i++) {
      const ch = body[i] as string;
      if (inString) {
        value += ch;
        if (ch === "\\") {
          value += body[i + 1] ?? "";
          i++;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        value += ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (ch === "," && depth === 0) {
        i++;
        break;
      }
      value += ch;
    }

    const trimmedKey = key.trim();
    // A computed key (a variable, a spread) is not something we can claim
    // to have read; skip it and let the `unparsed` flag speak.
    if (trimmedKey && !/[\s{}]/.test(trimmedKey)) {
      out.push({ key: trimmedKey, value: value.trim() });
    }
  }
  return out;
}

/** Extracts a repo-relative path from the literal expression forms we accept */
function literalPathFromExpression(expr: string): string | null {
  const trimmed = expr.trim().replace(/,$/, "");
  // path.resolve(__dirname, "./src")  |  path.join(__dirname, "src")
  const resolveArgs = /(?:path\.)?(?:resolve|join)\s*\(([^)]*)\)/.exec(trimmed);
  if (resolveArgs) {
    const args = splitArgs(resolveArgs[1] as string);
    // The last string literal is the relative tail we can use.
    for (let i = args.length - 1; i >= 0; i--) {
      const lit = unquote(args[i] as string);
      if (lit !== null) return lit;
    }
    return null;
  }
  // fileURLToPath(new URL("./src", import.meta.url))
  const urlForm = /new\s+URL\s*\(\s*(['"])([^'"]+)\1/.exec(trimmed);
  if (urlForm) return urlForm[2] as string;

  return unquote(trimmed);
}

function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function unquote(raw: string): string | null {
  const m = /^(['"])(.*)\1$/.exec(raw.trim());
  return m ? (m[2] as string) : null;
}

/** Returns the balanced `{...}` slice starting at `start`, or null */
function sliceBalanced(raw: string, start: number): string | null {
  if (raw[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start + 1, i);
    }
  }
  return null;
}

// ── Composition ──────────────────────────────────────────────

/** Files a caller should look for, in priority order */
export const TSCONFIG_CANDIDATES = [
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.base.json",
  "tsconfig.paths.json",
  "jsconfig.json",
];

export const VITE_CONFIG_CANDIDATES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vite.config.cts",
];

function prefixOf(pattern: string): string {
  // "foo/*" → "foo/", "foo" → "foo"
  return pattern.endsWith("/*") ? pattern.slice(0, -1) : pattern;
}

/**
 * Builds the alias rules for a workspace from the config files it has.
 *
 * Rules are ordered most-specific-first so `@components/` cannot be
 * swallowed by a broader `@` rule, and tsconfig wins over vite on a tie
 * because that is the order TypeScript itself resolves.
 */
export function readAliasConfig(params: {
  /** Path → file content, for the config files that exist */
  configs: Map<string, string>;
  /** Repo-relative paths present in the tree (for the `read` list) */
  treePaths?: Iterable<string>;
}): AliasConfig {
  const read: string[] = [];
  const rules: AliasRule[] = [];
  let unparsed = false;
  let root: string | null = null;

  const tsconfigPath = TSCONFIG_CANDIDATES.find((p) => params.configs.has(p));
  if (tsconfigPath) {
    read.push(tsconfigPath);
    const { baseUrl, paths } = parseTsconfigAliases(params.configs.get(tsconfigPath) ?? "");
    const base = baseUrl ? normalizeTarget(baseUrl) : "";
    for (const [pattern, targets] of Object.entries(paths)) {
      for (const target of targets) {
        let resolved = normalizeTarget(target);
        if (base && !resolved.startsWith(base)) resolved = joinPath(base, resolved);
        rules.push({ prefix: prefixOf(pattern), target: resolved, source: "tsconfig" });
      }
    }
  } else if (params.treePaths) {
    // A tsconfig in the tree we could not read is worth reporting.
    const present = [...params.treePaths].filter((p) => /^tsconfig(\..+)?\.json$|^jsconfig\.json$/.test(p));
    if (present.length > 0) {
      read.push(...present);
      unparsed = true;
    }
  }

  const vitePath = VITE_CONFIG_CANDIDATES.find((p) => params.configs.has(p));
  if (vitePath) {
    read.push(vitePath);
    const vite = parseViteConfigAliases(params.configs.get(vitePath) ?? "");
    root = vite.root;
    if (vite.unparsed) unparsed = true;
    for (const [from, to] of Object.entries(vite.alias)) {
      // Both sides keep whatever trailing slash they were written with, so
      // `@components/` stays a directory prefix and `@` stays exact.
      rules.push({ prefix: from, target: to, source: "vite" });
    }
  }

  // Longest prefix first: "@components/" before "@".
  rules.sort((a, b) => b.prefix.length - a.prefix.length);

  return { rules, root, unparsed, read };
}

function joinPath(a: string, b: string): string {
  const left = a.replace(/\/+$/, "");
  const right = b.replace(/^\/+/, "");
  return right ? `${left}/${right}` : left;
}

/**
 * Resolves an aliased specifier into a repo-relative path that exists,
 * trying the same extension candidates the FS resolver uses.
 *
 * Returns null when no rule matches or nothing exists — the caller then
 * treats the specifier as a package, which preserves today's behaviour
 * for projects without aliases.
 */
export function resolveAlias(
  specifier: string,
  config: AliasConfig,
  exists: (path: string) => boolean
): string | null {
  if (config.rules.length === 0) return null;
  const raw = specifier.split("?")[0] ?? "";
  if (!raw) return null;

  for (const rule of config.rules) {
    let rest: string | null = null;
    if (raw === rule.prefix) rest = "";
    else if (rule.prefix.endsWith("/") && raw.startsWith(rule.prefix)) {
      rest = raw.slice(rule.prefix.length);
    } else if (!rule.prefix.endsWith("/") && raw.startsWith(`${rule.prefix}/`)) {
      rest = raw.slice(rule.prefix.length + 1);
    }
    if (rest === null) continue;

    const base = rest ? joinPath(rule.target, rest) : rule.target.replace(/\/$/, "");
    const found = findWithExtensions(base, exists);
    if (found) return found;
  }
  return null;
}

/** Tries a path, then the extension and index candidates that exist */
function findWithExtensions(path: string, exists: (p: string) => boolean): string | null {
  if (exists(path)) return path;
  const candidates = [
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.jsx`,
    `${path}.mjs`,
    `${path}.cjs`,
    `${path}.mts`,
    `${path}.cts`,
    `${path}.css`,
    `${path}.json`,
    `${path}.vue`,
    `${path}.svelte`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
    `${path}/index.js`,
    `${path}/index.jsx`,
    `${path}/index.css`,
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
