// ============================================================
// Runtime Env — The Workspace's Environment, Held Per Repository
// ============================================================
// A repo runs on a laptop because the laptop has its configuration: the env
// vars `npm run dev` reads at startup. A browser workspace ships the code and
// mounts the tree, but until now it had nowhere to hold configuration — the
// spawn sites passed a hardcoded non-interactive env (`CI=1`, `NO_COLOR=1`)
// and nothing else, so a Supabase/Firebase/Stripe app got `undefined` for
// every key and "ran without any connection".
//
// This module is that missing layer. It holds a per-REPOSITORY key/value map
// — keys a user pasted once in conversation, values the doctor inferred from
// public literals in the repo — and hands the merged env to every spawn site:
// the executor's commands, the preview's dev server, and background
// processes.
//
// The policy that keeps this honest:
//
//   • Values live in THIS browser (IndexedDB), never in repo files, never in
//     a mount, never in cloud sync, never in the transcript. A user-pasted
//     `.env` is parsed into keys and values and then DISCARDED — the file
//     itself is never stored anywhere.
//
//   • Keys are merged LAST: they override the hardcoded base env. Nothing
//     here overrides the runtime's own env.
//
//   • The store is keyed by `owner/repo` (the same key the preview sessions
//     use), so configuration follows the repository, not the conversation —
//     the same discipline as the preview record.
//
// Pure data in, pure data out. Storage is `idb-storage.service`, and every
// failure degrades to an in-memory map for the session rather than a throw —
// an unavailable store costs persistence, never a command.
// ============================================================

import { readValue, writeValue } from "@/services/idb-storage.service";
import { isCommittedEnvFilePath } from "../lib/sensitivity";

/** IndexedDB key the per-repo env maps live under (same store as the preview records) */
const RUNTIME_ENV_KEY = "intab_workspace_runtime_env";

/** The persisted shape. Versioned so an old record can never parse as a new one. */
interface StoredRuntimeEnv {
  version: 1;
  /** `owner/repo` → key → value */
  byRepo: Record<string, Record<string, string>>;
}

const EMPTY: StoredRuntimeEnv = { version: 1, byRepo: {} };

/** The session's working copy — authoritative between loads, written through to IDB */
let cache: StoredRuntimeEnv | null = null;
/** In-flight load, so two callers racing the first read cannot split the cache */
let loading: Promise<StoredRuntimeEnv> | null = null;

function parse(raw: string | null): StoredRuntimeEnv {
  if (!raw) return { ...EMPTY, byRepo: {} };
  try {
    const parsed = JSON.parse(raw) as StoredRuntimeEnv;
    if (parsed?.version !== 1 || typeof parsed.byRepo !== "object" || parsed.byRepo === null) {
      return { ...EMPTY, byRepo: {} };
    }
    const byRepo: Record<string, Record<string, string>> = {};
    for (const [repo, vars] of Object.entries(parsed.byRepo)) {
      if (typeof vars !== "object" || vars === null) continue;
      const clean: Record<string, string> = {};
      for (const [key, value] of Object.entries(vars)) {
        if (typeof value === "string") clean[key] = value;
      }
      byRepo[repo] = clean;
    }
    return { version: 1, byRepo };
  } catch {
    return { ...EMPTY, byRepo: {} };
  }
}

function normalizeRepoKey(owner: string | null | undefined, repo: string | null | undefined): string | null {
  const o = (owner ?? "").trim();
  const r = (repo ?? "").trim();
  if (!o || !r) return null;
  return `${o}/${r}`;
}

/** The env for one repo, or {} — never undefined, never a shared reference */
function envOf(state: StoredRuntimeEnv, repoKey: string | null): Record<string, string> {
  if (!repoKey) return {};
  const found = state.byRepo[repoKey];
  return found ? { ...found } : {};
}

async function load(): Promise<StoredRuntimeEnv> {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    let raw: string | null = null;
    try {
      raw = await readValue(RUNTIME_ENV_KEY);
    } catch {
      // Unavailable storage degrades to the in-memory map: persistence is the
      // backup plan, not the primary copy.
    }
    cache = parse(raw);
    return cache;
  })();
  return loading;
}

/** Writes through to IDB. Never throws — storage failure costs persistence only. */
async function persist(state: StoredRuntimeEnv): Promise<void> {
  try {
    await writeValue(RUNTIME_ENV_KEY, JSON.stringify(state));
  } catch {
    // Degrade to session memory; the next load re-derives from storage or starts empty.
  }
}

/**
 * The env to spawn a workspace process with: the runtime's non-interactive
 * base, with the repo's stored vars overriding it.
 *
 * One merge point for all three spawn sites, so precedence can never disagree
 * between a command and the preview's dev server. `repoKey` is `owner/repo`
 * (`repoKeyOf`); null simply yields the base env.
 */
export async function mergeContainerEnv(
  base: Readonly<Record<string, string>>,
  repoKey: string | null
): Promise<Record<string, string>> {
  const state = await load();
  return { ...base, ...envOf(state, repoKey) };
}

/**
 * Sets (or clears) one variable for one repository, and reports the outcome.
 *
 * A `null` value removes the key — the way a correction reads ("that URL was
 * for staging, here is prod") rather than leaving a stale value to win.
 * Returns what changed so the caller can state the effect instead of implying
 * one.
 */
export async function setRepoEnvVar(
  owner: string | null | undefined,
  repo: string | null | undefined,
  key: string,
  value: string | null
): Promise<{ ok: true; repoKey: string; previously: "set" | "absent"; action: "set" | "removed" } | { ok: false; error: string }> {
  const repoKey = normalizeRepoKey(owner, repo);
  if (!repoKey) return { ok: false, error: "no repository is attached to this conversation" };
  const trimmedKey = key.trim();
  if (!trimmedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
    return { ok: false, error: `"${key}" is not a valid environment variable name (letters, digits, underscores; cannot start with a digit).` };
  }
  const state = await load();
  const vars = envOf(state, repoKey);
  const previously = trimmedKey in vars ? "set" : "absent";
  if (value === null) {
    if (previously === "absent") {
      return { ok: true, repoKey, previously, action: "removed" };
    }
    delete vars[trimmedKey];
  } else {
    vars[trimmedKey] = value;
  }
  const next: StoredRuntimeEnv = { version: 1, byRepo: { ...state.byRepo, [repoKey]: vars } };
  // Empty map for a repo whose last var was removed: drop the entry entirely,
  // so the store never accretes empty shells.
  if (Object.keys(next.byRepo[repoKey] ?? {}).length === 0) delete next.byRepo[repoKey];
  cache = next;
  await persist(next);
  return { ok: true, repoKey, previously, action: value === null ? "removed" : "set" };
}

/**
 * Stores every key/value pair of a parsed `.env` body in one write.
 *
 * Used by the conversational path: the user pastes their laptop's env file
 * into chat, the agent hands the text here, and the file itself is discarded —
 * only the pairs survive, per repo, in this browser.
 */
export async function setRepoEnvFromText(
  owner: string | null | undefined,
  repo: string | null | undefined,
  text: string
): Promise<{ ok: true; keys: string[]; repoKey: string } | { ok: false; error: string }> {
  const repoKey = normalizeRepoKey(owner, repo);
  if (!repoKey) return { ok: false, error: "no repository is attached to this conversation" };
  const parsed = parseEnvText(text);
  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    return { ok: false, error: "no `KEY=value` lines were found in that text — nothing was stored." };
  }
  const state = await load();
  const vars = { ...envOf(state, repoKey), ...parsed };
  const next: StoredRuntimeEnv = { version: 1, byRepo: { ...state.byRepo, [repoKey]: vars } };
  cache = next;
  await persist(next);
  return { ok: true, keys, repoKey };
}

/**
 * The keys one repository has stored — for the doctor's verdict and for
 * reporting what will reach the next spawn, WITHOUT the values.
 */
export async function repoEnvKeys(owner: string | null | undefined, repo: string | null | undefined): Promise<string[]> {
  const state = await load();
  return Object.keys(envOf(state, normalizeRepoKey(owner, repo))).sort((a, b) => a.localeCompare(b));
}

/**
 * The env a mount plan's committed env files contribute to a spawn's PROCESS
 * environment.
 *
 * The file being on disk is only half of what a laptop does: a variable that
 * does not start with a framework prefix (`VITE_`, `NEXT_PUBLIC_`) is never
 * inlined into a browser bundle, and laptop code reaches it through
 * `process.env` — the dev server's environment, a vite config's `loadEnv`, a
 * server route. The workspace reproduces that by handing every variable the
 * commit's own env files define to the spawned process as real env vars.
 *
 * Precedence at the call site: base < committed-file vars < user-stored vars.
 * A user's explicit correction outranks the file; the file outranks nothing
 * the runtime needs.
 */
export function committedEnvVarsOfTree(tree: unknown): Record<string, string> {
  // `tree` is a WebContainer FileSystemTree; walked structurally to avoid an
  // import cycle and to stay honest about what we read: only `.env`-family
  // TEXT files at any depth contribute, and `.npmrc` (key material) does not.
  const out: Record<string, string> = {};
  const walk = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [name, child] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child && typeof child === "object" && "directory" in (child as Record<string, unknown>)) {
        walk((child as { directory: unknown }).directory, path);
        continue;
      }
      if (!isCommittedEnvFilePath(path)) continue;
      const contents = (child as { file?: { contents?: unknown } }).file?.contents;
      if (typeof contents !== "string") continue;
      for (const [key, value] of Object.entries(parseEnvText(contents))) {
        out[key] = value;
      }
    }
  };
  walk(tree, "");
  return out;
}

/**
 * The full spawn env for one repo, given the mounted tree: the non-interactive
 * base, then every committed env-file variable, then the user's stored vars.
 *
 * One function so the executor, the preview and the process registry cannot
 * disagree about the order — and so a non-`VITE_` variable in a committed
 * `.env` reaches `process.env` the way it reaches it on a laptop.
 */
export async function spawnEnvFor(
  base: Readonly<Record<string, string>>,
  repoKey: string | null,
  tree: unknown
): Promise<Record<string, string>> {
  const state = await load();
  return {
    ...base,
    ...committedEnvVarsOfTree(tree),
    ...envOf(state, repoKey),
  };
}

/**
 * Persists the values the doctor lifted from public literals — once per repo,
 * idempotently, never overwriting a value that already exists.
 *
 * The doctor has already decided these values are public-by-design (a
 * Supabase project URL in a fallback expression); this only makes them stick,
 * so the next dev server starts with them without anyone asking. A value the
 * user stored explicitly always wins.
 */
export async function inferRepoEnvFromPublicLiterals(
  owner: string | null | undefined,
  repo: string | null | undefined,
  entries: readonly { key: string; value: string }[]
): Promise<{ keys: string[] }> {
  const repoKey = normalizeRepoKey(owner, repo);
  if (!repoKey || entries.length === 0) return { keys: [] };
  const state = await load();
  const vars = envOf(state, repoKey);
  const added: string[] = [];
  for (const entry of entries) {
    if (entry.key in vars) continue; // explicit beats inferred
    vars[entry.key] = entry.value;
    added.push(entry.key);
  }
  if (added.length === 0) return { keys: [] };
  const next: StoredRuntimeEnv = { version: 1, byRepo: { ...state.byRepo, [repoKey]: vars } };
  cache = next;
  await persist(next);
  return { keys: added.sort((a, b) => a.localeCompare(b)) };
}

/** Test seam: forget the in-memory copy (the next read re-loads from storage) */
export function resetRuntimeEnvForTest(): void {
  cache = null;
  loading = null;
}

/**
 * Parses an `.env`-shaped text body into key/value pairs.
 *
 * Tolerant of what real env files contain: `export KEY=value` prefixes, quoted
 * values (single, double, and unbalanced), inline comments after whitespace,
 * blank lines and comments. Not a shell — no variable expansion, no
 * multi-line values; those never survive a chat paste intact anyway.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // An unquoted value ends at unescaped whitespace followed by `#`.
      const hash = value.search(/\s#/);
      if (hash > 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}
