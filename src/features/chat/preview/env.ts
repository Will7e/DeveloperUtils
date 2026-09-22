// ============================================================
// Preview Environment — .env Files + esbuild `define`
// ============================================================
// A bundled app reads its configuration at module scope, and Vite apps
// read it through `import.meta.env`. esbuild does not know that object
// exists, so before this module the bundle contained a literal
// `import.meta.env.VITE_SUPABASE_URL` that evaluated to `undefined` — and
// the very common shape `createClient(import.meta.env.VITE_URL, …)`
// threw while mounting. The app died before attaching a listener, so the
// pane showed a rendered page on which nothing worked.
//
// This module reads the repository's own .env files and synthesizes the
// `define` map, following Vite's contract: only VITE_-prefixed keys are
// exposed, plus the built-ins (MODE, BASE_URL, DEV, PROD, SSR).
//
// Two honesty rules, because this is the one place where pretending is
// most tempting:
//   • a key that is NOT declared is reported by name only — never a
//     value — so an agent cannot leak a secret into a transcript;
//   • .env files that exist but were not loaded are listed, so "my
//     preview has no env" is answerable instead of mysterious.
//
// Pure: text in, plain objects out.
// ============================================================

/** Vite's env-file precedence, lowest first (later files win) */
export function envFileCandidates(mode: string): string[] {
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
}

export interface ParsedDotEnv {
  values: Record<string, string>;
  /** Keys declared without a value, which Vite treats as "not set" */
  empty: string[];
}

/**
 * Parses one .env file: `KEY=value`, optional `export`, comments, quoted
 * values with escapes. Multi-line quoted values are not supported — they
 * are vanishingly rare in .env files and silently joining them would
 * corrupt a value rather than skip it.
 */
export function parseDotEnv(raw: string | null | undefined): ParsedDotEnv {
  const values: Record<string, string> = {};
  const empty: string[] = [];
  if (!raw) return { values, empty };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0] as string;
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      // Unquoted values end at an unescaped comment marker.
      value = value.replace(/\s+#.*$/, "").trim();
    }

    if (value === "") empty.push(key);
    else values[key] = value;
  }
  return { values, empty };
}

/** Merges the candidate files in Vite's precedence order (later wins) */
export function resolveDotEnv(files: Map<string, string>, mode: string): {
  values: Record<string, string>;
  read: string[];
  empty: string[];
} {
  const values: Record<string, string> = {};
  const read: string[] = [];
  const empty: string[] = [];
  for (const path of envFileCandidates(mode)) {
    const raw = files.get(path);
    if (raw === undefined) continue;
    read.push(path);
    const parsed = parseDotEnv(raw);
    for (const key of parsed.empty) delete values[key];
    Object.assign(values, parsed.values);
  }
  return { values, read, empty };
}

export interface PreviewEnv {
  /** Everything the app may see through `import.meta.env` */
  exposed: Record<string, string | boolean>;
  /** Keys present in .env files but NOT exposed (no VITE_ prefix) */
  withheld: string[];
  /** .env files that were read */
  read: string[];
  /** .env-shaped files present in the repo that were skipped */
  skipped: string[];
  /** Names (never values) of keys whose value looks like a secret */
  secretLike: string[];
}

const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|SERVICE_ROLE)/i;

/**
 * Builds the `import.meta.env` object for a repository.
 *
 * `mode` defaults to "production": the preview runs a BUILT bundle, and
 * claiming DEV=true would enable code paths (HMR sockets, dev warnings,
 * debug overlays) that cannot work here.
 */
export function buildPreviewEnv(params: {
  /** .env files that exist in the workspace, by path */
  envFiles?: Map<string, string>;
  /** Every path in the tree, for reporting skipped env files */
  treePaths?: Iterable<string>;
  mode?: string;
  baseUrl?: string;
}): PreviewEnv {
  const mode = params.mode ?? "production";
  const { values, read } = resolveDotEnv(params.envFiles ?? new Map(), mode);

  const exposed: Record<string, string | boolean> = {
    MODE: mode,
    BASE_URL: params.baseUrl ?? "/",
    DEV: mode === "development",
    PROD: mode === "production",
    SSR: false,
  };

  const withheld: string[] = [];
  const secretLike: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("VITE_")) {
      // Vite refuses to expose these, and so does the preview — a
      // non-prefixed key is exactly where a server secret lives.
      withheld.push(key);
      continue;
    }
    if (SECRET_KEY.test(key)) secretLike.push(key);
    exposed[key] = value;
  }

  const skipped = [...(params.treePaths ?? [])].filter((p) => {
    const base = p.split("/").pop() ?? "";
    return /^\.env(\.|$)/.test(base) && !read.includes(p);
  });

  return { exposed, withheld, read, skipped: skipped.sort(), secretLike };
}

/**
 * esbuild `define` entries.
 *
 * `import.meta.env` is defined as a WHOLE OBJECT rather than as one key
 * per variable. esbuild substitutes the longest matching member
 * expression, so `import.meta.env.VITE_X` becomes `({…}).VITE_X` and
 * still evaluates correctly — while a per-key map would need re-emitting
 * on every .env change and would miss computed access such as
 * `import.meta.env[key]`.
 */
export function buildDefineMap(env: PreviewEnv): Record<string, string> {
  return {
    "import.meta.env": JSON.stringify(env.exposed),
    // HMR cannot work in a static preview bundle; guarding code checks it.
    "import.meta.hot": "undefined",
    // Vite's glob import IS supported — ./glob rewrites the static patterns
    // while building. This points whatever the rewrite could not resolve (a
    // computed pattern, an unsupported option, or a call inside a fetched
    // package) at a function that explains itself, because the alternative is
    // `TypeError: (intermediate value).glob is not a function`.
    "import.meta.glob": "__intabGlobUnavailable",
    "import.meta.globEager": "__intabGlobUnavailable",
    "process.env.NODE_ENV": JSON.stringify(env.exposed.PROD ? "production" : "development"),
  };
}

/**
 * One diagnostic line describing what the preview did with the repo's
 * environment. Names only — a .env file is often a secret store, and a
 * diagnostic is the last place a value should appear.
 */
export function describeEnv(env: PreviewEnv): string | null {
  if (env.read.length === 0 && env.skipped.length === 0) return null;
  const parts: string[] = [];
  if (env.read.length > 0) parts.push(`read ${env.read.join(", ")}`);
  if (env.skipped.length > 0) {
    parts.push(
      `skipped ${env.skipped.join(", ")} (not loaded: a preview bundle cannot be granted secrets you did not commit)`
    );
  }
  if (env.withheld.length > 0) {
    parts.push(`not exposed (no VITE_ prefix): ${env.withheld.join(", ")}`);
  }
  if (env.secretLike.length > 0) {
    // Names only. The whole point of the warning is that these values are
    // about to be embedded in a bundle the preview can read.
    parts.push(
      `exposed but shaped like a secret (recheck these are publishable): ${env.secretLike.join(", ")}`
    );
  }
  return `Preview environment: ${parts.join("; ")}.`;
}
