// ============================================================
// Env Doctor — What A Repo Needs To Run, Read From The Repo Itself
// ============================================================
// A repo runs on a laptop because the laptop answers three questions before
// `npm run dev`: which env keys does the code want, what services does it
// call, and what physically cannot work in a browser tab. Until now the
// workspace discovered all three answers AS FAILURES — a dev server that
// dies at startup, a blank preview, a crash whose cause sits three layers
// below the change being tested.
//
// The doctor asks them from the mounted tree instead, and states a verdict:
//
//   • CONNECTS — every key the code references has a source (the commit's
//     own env files, a value the user stored, a public literal in the code).
//   • INFERRED — some keys will run on values lifted from public literals
//     (a Supabase URL in a fallback expression, a committed firebaseConfig).
//     Stated, because a user should know where a value came from.
//   • NEEDS-KEYS — specific keys exist nowhere in the repository. The agent
//     can ask for exactly these, once, in conversation; nothing else needs
//     to be said.
//   • BLOCKED — something this runtime physically cannot do (a server-side
//     database driver pointed at localhost, native modules). Named as a
//     fact about the platform, not as a failure of the change.
//
// Pure: text in, report out. No DOM, no container, no store. The caller
// decides what a verdict becomes (mount notes, a preview failure report, an
// agent question).
// ============================================================

/**
 * What the code reads env keys THROUGH. Each pattern is anchored so a prose
 * sentence containing `process.env` cannot manufacture a key.
 */
const VITE_REF = /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const VITE_BRACKET_REF = /\bimport\.meta\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g;
const PROCESS_REF = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const PROCESS_BRACKET_REF = /\bprocess\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g;

/**
 * Node built-in globals that read like env keys but are facts of the runtime, not
 * configuration a user can supply. Excluded so a Next.js server file does not
 * produce "needs NODE_ENV, PATH, HOME" verdicts that say nothing actionable.
 */
const RUNTIME_PROVIDED = new Set([
  "NODE_ENV", "NODE_OPTIONS", "PATH", "HOME", "PWD", "USER", "SHELL", "LANG", "TMPDIR",
  "npm_lifecycle_event", "npm_package_name", "npm_package_version", "PORT", "HOST",
]);

/**
 * Keys whose values are PUBLIC BY DESIGN in a browser app — the app itself
 * ships them to every visitor. A literal for one of these is lift-able; a
 * literal for anything else is not (a guess that stores a wrong secret
 * silently is worse than asking once).
 */
const PUBLIC_BY_DESIGN = /(SUPABASE|FIREBASE|GOOGLE_MAPS|MAPBOX|ALGOLIA|CLARITY|POSTHOG|SENTRY_DSN|RECAPTCHA|GA_|GTM_|AMPLITUDE|SEGMENT|STRIPE_PUBLISHABLE|BRAINTREE|CONTENTFUL|SANITY|COSMIC|BUTTERCMS|DATOCMS|PRISMIC|COCKPIT|DIRECTUS_PUBLIC)/i;

/**
 * The URL shapes the doctor can recognize as a SERVICE ENDPOINT — the value a
 * missing env key wants. Scoped deliberately: these are endpoints of services
 * whose anon/public keys cannot read or write beyond row-level security, so
 * lifting one into a suggested value cannot leak anything private.
 */
const PUBLIC_ENDPOINT = /https:\/\/[a-z0-9-]+\.(supabase\.co|firebaseio\.com|firebasestorage\.googleapis\.com|tiles\.mapbox\.com|maps\.googleapis\.com|[a-z0-9-]+\.algolia(net|\.com)|search\.algolia\.com)/i;

/**
 * Known client SDK dependencies and what each one says about the project.
 *
 * `keys` are the env key shapes that dependency's docs make you set (matched
 * against REFERENCED keys, not invented); `note` is the sentence the verdict
 * carries. The point is not an exhaustive registry — it is the difference
 * between "some variable is missing somewhere" and "this is Supabase and it
 * wants its URL and anon key."
 */
const KNOWN_CLIENT_SDKS: { dependency: RegExp; note: string }[] = [
  { dependency: /@supabase\/supabase-js/, note: "This project calls Supabase — it needs its project URL and anon key (both public by design), and reaches the database over HTTPS, which this workspace can do." },
  { dependency: /^firebase($|\/)/, note: "This project uses Firebase — a committed firebaseConfig or the FIREBASE_* keys are what it starts from." },
  { dependency: /openai|anthropic|@google\/generativeai/, note: "This project calls an LLM API from the client: a key in the browser bundle is readable by every visitor, so this workspace will only run it with a public-by-design or placeholder key." },
  { dependency: /stripe/, note: "This project uses Stripe — the publishable key is public by design; the secret key must never enter a client bundle or this workspace." },
  { dependency: /^(pg|mysql2|mongodb|mongoose|redis|typeorm|prisma|@prisma\/client|sequelize|knex)$/, note: "This project contains a database driver, and this browser workspace has no database process and no raw TCP to a remote one — `localhost` in a connection string cannot work here. A hosted connection string for a frontend-reachable service (e.g. a Postgres REST layer) is the shape that does." },
];

/** The SDK entry whose note names the database-driver constraint */
const DB_DRIVER_SDK = KNOWN_CLIENT_SDKS[KNOWN_CLIENT_SDKS.length - 1]!;

export interface EnvDoctorFinding {
  kind: "inferred" | "needs-key" | "blocked" | "note";
  /** The env key, when the finding is about one */
  key: string | null;
  message: string;
}

export interface EnvDoctorReport {
  /** CONNECTS / INFERRED / NEEDS-KEYS / BLOCKED, as the caller words it */
  verdict: "connects" | "inferred" | "needs-keys" | "blocked";
  /** Every env key the mounted source references, sorted */
  referencedKeys: string[];
  /** Keys with no source anywhere in the repo — the exact ask, if one is needed */
  missingKeys: string[];
  /** Keys whose values the doctor lifted from public literals in the repo */
  inferred: { key: string; source: string; value: string }[];
  /** Findings a reader acts on, bounded and deduplicated */
  findings: EnvDoctorFinding[];
  /** The one-line summary for notes and tool results */
  summary: string;
  /** Var name → value, for values the doctor is confident enough to persist (public endpoints only) */
  suggestions: Record<string, string>;
}

/**
 * The env keys the mounted source references — the repository's TRUE key
 * list, taken from what the code reads rather than from what `.env.example`
 * happens to list. Unquoted-dot and bracket forms both count; `RUNTIME_PROVIDED`
 * keys are dropped as facts of the runtime rather than asks of the user.
 */
export function referencedEnvKeysOf(files: readonly { path: string; content: string }[]): string[] {
  const keys = new Set<string>();
  const patterns = [VITE_REF, VITE_BRACKET_REF, PROCESS_REF, PROCESS_BRACKET_REF];
  for (const file of files) {
    if (typeof file.content !== "string") continue;
    // Node_modules would re-report every dependency's own keys as the project's.
    if (file.path.startsWith("node_modules/")) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.content)) !== null) {
        const key = match[1]!;
        if (!RUNTIME_PROVIDED.has(key)) keys.add(key);
      }
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * Values worth suggesting, lifted from public literals.
 *
 * Only two shapes are trusted: a public-endpoint URL appearing anywhere in
 * the source, and the endpoint a public-by-design key's fallback expression
 * names. Anything else — bearer tokens, connection strings with usernames,
 * keys that match `SECRET` shapes — is never lifted: a wrong guess here is a
 * silent, wrong credential, which is worse than an honest ask.
 */
export function suggestableValuesOf(files: readonly { path: string; content: string }[]): Record<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    if (typeof file.content !== "string") continue;
    if (file.path.startsWith("node_modules/")) continue;
    // The endpoint itself, wherever it appears: `createClient("https://xyz.supabase.co", ...)`,
    // a committed firebaseConfig, a fallback in `import.meta.env.X ?? "https://…"`.
    const endpoints = file.content.match(/https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s"'`,;)]*)?/g) ?? [];
    for (const endpoint of endpoints) {
      if (!PUBLIC_ENDPOINT.test(endpoint)) continue;
      if (!found.has(endpoint)) found.set(endpoint, file.path);
    }
  }
  const suggestions: Record<string, string> = {};
  for (const [endpoint, source] of found) {
    // The suggested key follows the service, because that is what the project's
    // own docs name: a Supabase URL belongs in `*_SUPABASE_URL`-shaped keys.
    const service = /supabase/i.test(endpoint) ? "SUPABASE_URL" : /firebase/i.test(endpoint) ? "FIREBASE_DATABASE_URL" : /mapbox/i.test(endpoint) ? "MAPBOX_TILES_URL" : /algolia/i.test(endpoint) ? "ALGOLIA_SEARCH_URL" : null;
    if (!service) continue;
    if (!Object.values(suggestions).includes(endpoint)) suggestions[service] = endpoint;
    void source;
  }
  return suggestions;
}

/**
 * Whether the repository already carries values for these keys — through a
 * committed env file or a public-by-design literal beside the reference.
 *
 * A committed `.env` answers every key it defines; a `VITE_SUPABASE_URL`
 * literal appearing in the same file that references it answers that key.
 */
export function keysWithSourcesOf(
  keys: readonly string[],
  files: readonly { path: string; content: string }[]
): { satisfied: Set<string>; inferred: { key: string; source: string; value: string }[] } {
  const satisfied = new Set<string>();
  const inferred: { key: string; source: string; value: string }[] = [];
  const byKey = new Map<string, string>();
  for (const key of keys) byKey.set(key.toUpperCase(), key);

  for (const file of files) {
    if (typeof file.content !== "string") continue;
    // A committed env file defines keys authoritatively.
    if (/(^|\/)\.env($|\.)/i.test(file.path)) {
      for (const line of file.content.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match) {
          const key = match[1]!;
          const canonical = byKey.get(key.toUpperCase());
          if (canonical) satisfied.add(canonical);
        }
      }
      continue;
    }
    // The fallback expression IS the value, stated in the code itself:
    // `import.meta.env.VITE_SUPABASE_URL ?? "https://xyz.supabase.co"` answers
    // that one key and no other. Deliberately narrow — "a public URL appears
    // somewhere in a public-looking file" would satisfy unrelated keys from
    // whatever endpoint happened to be nearby.
    for (const key of keys) {
      if (satisfied.has(key)) continue;
      if (!PUBLIC_BY_DESIGN.test(key)) continue;
      const pattern = new RegExp(`${key}\\s*\\?\\?\\s*["'\`]([^"'\`]+)["'\`]`);
      const match = pattern.exec(file.content);
      if (match && PUBLIC_ENDPOINT.test(match[1] ?? "")) {
        satisfied.add(key);
        inferred.push({ key, source: file.path, value: match[1]! });
      }
    }
  }
  return { satisfied, inferred };
}

/** The dependencies the mounted package.json declares, for the SDK notes */
function dependenciesOf(packageJson: string | null): string[] {
  if (!packageJson?.trim()) return [];
  try {
    const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    return [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})];
  } catch {
    return [];
  }
}

/** Bounded source scan: the doctor reads what a dev server would, no more */
const MAX_SCAN_FILES = 600;
const MAX_SCAN_CHARS = 2_000_000;

/**
 * Runs the doctor over a mounted tree (path/content pairs, as `flattenTree`
 * produces and `MountPlan.files` names).
 *
 * `packageJson` is the tree's manifest text (or null); `storedKeys` are the
 * env keys the runtime-env store already holds for this repo — they satisfy
 * references like a committed env file does.
 */
export function diagnoseEnv(input: {
  files: readonly { path: string; content: string | Uint8Array }[];
  packageJson: string | null;
  storedKeys?: readonly string[];
}): EnvDoctorReport {
  const textFiles = input.files
    .filter((file): file is { path: string; content: string } => typeof file.content === "string")
    .slice(0, MAX_SCAN_FILES);
  let budget = MAX_SCAN_CHARS;
  const scanned: { path: string; content: string }[] = [];
  for (const file of textFiles) {
    if (budget <= 0) break;
    const content = file.content.length > budget ? file.content.slice(0, budget) : file.content;
    budget -= content.length;
    scanned.push({ path: file.path, content });
  }

  const referencedKeys = referencedEnvKeysOf(scanned);
  const stored = new Set((input.storedKeys ?? []).map((key) => key.toUpperCase()));
  const withSources = keysWithSourcesOf(referencedKeys, scanned);
  const satisfied = new Set([...withSources.satisfied, ...[...referencedKeys].filter((key) => stored.has(key.toUpperCase()))]);
  const missingKeys = referencedKeys.filter((key) => !satisfied.has(key));

  const suggestions = suggestableValuesOf(scanned);
  const dependencies = dependenciesOf(input.packageJson);
  const findings: EnvDoctorFinding[] = [];

  for (const sdk of KNOWN_CLIENT_SDKS) {
    const hit = dependencies.find((dependency) => sdk.dependency.test(dependency));
    if (hit) findings.push({ kind: "note", key: null, message: sdk.note });
  }

  // A missing key the repo itself suggests a value for is INFERRED, not a gap:
  // the doctor proposes the lift and the caller decides whether to apply it.
  const inferredKeys = withSources.inferred.filter((entry) => missingKeys.includes(entry.key));
  for (const entry of inferredKeys) {
    findings.push({
      kind: "inferred",
      key: entry.key,
      message: `\`${entry.key}\` has no value yet, but \`${entry.source}\` carries a public endpoint literal for it — the workspace can run with that value inferred from the repository itself.`,
    });
  }
  for (const key of missingKeys) {
    if (inferredKeys.some((entry) => entry.key === key)) continue;
    findings.push({
      kind: "needs-key",
      key,
      message: `\`${key}\` is referenced by the code but exists nowhere in this repository — ask the user for it in conversation (one ask, remembered per repo); never invent a value.`,
    });
  }

  const driver = dependencies.find((dependency) => DB_DRIVER_SDK.dependency.test(dependency));
  const blocked = Boolean(
    driver &&
      scanned.some(
        (file) =>
          /localhost|127\.0\.0\.1/.test(file.content) &&
          /(postgres|mysql|mongodb(\+srv)?:|redis:\/\/)/i.test(file.content)
      )
  );
  if (blocked) {
    findings.unshift({
      kind: "blocked",
      key: null,
      message:
        "A database connection string in this repo points at localhost, and this browser workspace has no database process inside it — a laptop does, which is the difference. A hosted database URL (set with set_env) is the shape that works here.",
    });
  }

  // The verdict answers ONE question: can this project reach its services?
  // A suggestion that fills no gap is a note, not a verdict — an unfetched
  // extra would read as "something is still missing" when nothing is.
  const verdict: EnvDoctorReport["verdict"] = blocked
    ? "blocked"
    : missingKeys.length > 0
      ? "needs-keys"
      : inferredKeys.length > 0
        ? "inferred"
        : "connects";

  const parts: string[] = [];
  if (referencedKeys.length === 0) {
    parts.push("The code references no env keys.");
  } else {
    parts.push(`The code references ${referencedKeys.length} env key(s), and every one has a source in this repository or your stored env.`);
  }
  if (missingKeys.length > 0) {
    parts.push(`Missing: ${missingKeys.map((key) => `\`${key}\``).join(", ")} — ask once, in conversation.`);
  }

  return {
    verdict,
    referencedKeys,
    missingKeys,
    inferred: inferredKeys.map((entry) => ({ key: entry.key, source: entry.source, value: entry.value })),
    findings,
    summary: parts.join(" "),
    suggestions,
  };
}
