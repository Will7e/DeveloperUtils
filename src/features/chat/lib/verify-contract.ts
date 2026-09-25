// ============================================================
// Verification Contract — What This Repo Says Must Be Checked
// ============================================================
// The harness has no shell, so it cannot run a test suite. That is a
// fact about the architecture, not an excuse — and the difference
// between an honest harness and a dishonest one is entirely in what it
// does about that fact:
//
//   • an agent that does not know the repo's checks will invent them
//     ("all tests pass") and be believed;
//   • an agent that DOES know them can name exactly which ones it could
//     not run, and hand the user the commands — which is checkable,
//     falsifiable, and useful.
//
// So the contract is read from the repository itself, in priority order:
//
//   1. `.intab/verify.json` — an explicit manifest, the strongest
//      signal, and the file a team edits to teach the agent its checks;
//   2. `package.json` scripts — the convention almost every JS repo
//      already has (test / lint / typecheck / build);
//   3. `AGENTS.md` — fenced commands under a Checks/Verification
//      heading, for repos whose checks are not in a manifest.
//
// Nothing here executes anything. It reports what SHOULD run, and
// `run_checks` (services/agent-actions.ts) is the one place that may
// hand the list to an external runner when one is configured.
//
// Pure: parsing and shaping only, so the rules are unit-testable.

/** Path of the explicit manifest (checked first) */
export const VERIFY_MANIFEST_PATH = ".intab/verify.json";

export type CheckSource = "manifest" | "package" | "agents-md";

export interface DeclaredCheck {
  /** Stable id (also what the runner echoes back) */
  id: string;
  /** Human label */
  label: string;
  /** Shell command as the repository declares it */
  command: string;
  source: CheckSource;
}

/** Importance order — cheapest, most-decisive checks first */
const SCRIPT_PRIORITY = [
  "typecheck",
  "type-check",
  "tsc",
  "lint",
  "test",
  "build",
  "check",
  "e2e",
] as const;

/** Scripts that look like a verification of the change set */
function isVerificationScript(name: string): boolean {
  const base = name.toLowerCase();
  if (SCRIPT_PRIORITY.includes(base as (typeof SCRIPT_PRIORITY)[number])) return true;
  return /^(test|lint|typecheck|type-check|check|verify|e2e)(:|$)/.test(base);
}

/** Rank for ordering (unknown hits sort last but stay visible) */
function scriptRank(name: string): number {
  const base = name.toLowerCase();
  const idx = SCRIPT_PRIORITY.indexOf(base as (typeof SCRIPT_PRIORITY)[number]);
  if (idx !== -1) return idx;
  const prefixIdx = SCRIPT_PRIORITY.findIndex((p) => base.startsWith(`${p}:`));
  return prefixIdx === -1 ? SCRIPT_PRIORITY.length : prefixIdx;
}

function checkId(prefix: string, raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `${prefix}:${slug}` : prefix;
}

/**
 * Reads `.intab/verify.json`. Accepted shapes (all forgiving, because a
 * manifest that fails to parse is worse than no manifest):
 *
 *   { "checks": [ { "id"?, "label"?, "command" } ] }
 *   { "checks": [ "npm test" ] }
 *   { "check": "npm test" }
 */
export function parseVerifyManifest(raw: string | null | undefined): {
  checks: DeclaredCheck[];
  error?: string;
} {
  if (!raw || !raw.trim()) return { checks: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { checks: [], error: `${VERIFY_MANIFEST_PATH} is not valid JSON.` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { checks: [], error: `${VERIFY_MANIFEST_PATH} must be a JSON object.` };
  }

  const obj = json as { checks?: unknown; check?: unknown };
  const rawList = Array.isArray(obj.checks)
    ? obj.checks
    : obj.check !== undefined
      ? [obj.check]
      : [];
  if (rawList.length === 0) {
    return { checks: [], error: `${VERIFY_MANIFEST_PATH} declares no checks.` };
  }

  const checks: DeclaredCheck[] = [];
  rawList.slice(0, 20).forEach((entry, i) => {
    if (typeof entry === "string") {
      const command = entry.trim();
      if (!command) return;
      checks.push({
        id: checkId("manifest", `check-${i + 1}`),
        label: command,
        command,
        source: "manifest",
      });
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    const e = entry as { id?: unknown; label?: unknown; command?: unknown };
    const command = typeof e.command === "string" ? e.command.trim() : "";
    if (!command) return;
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : command;
    checks.push({
      id:
        typeof e.id === "string" && e.id.trim()
          ? checkId("manifest", e.id)
          : checkId("manifest", label),
      label,
      command,
      source: "manifest",
    });
  });

  return { checks };
}

/** Reads verification scripts out of a `package.json` */
export function checksFromPackageJson(raw: string | null | undefined): DeclaredCheck[] {
  if (!raw || !raw.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const scripts = (json as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];

  const entries = Object.entries(scripts as Record<string, unknown>)
    .filter(([name, cmd]) => typeof cmd === "string" && isVerificationScript(name))
    .sort((a, b) => scriptRank(a[0]) - scriptRank(b[0]) || a[0].localeCompare(b[0]));

  const manager = detectPackageManager(json as Record<string, unknown>);
  return entries.slice(0, 12).map(([name]) => ({
    id: checkId("package", name),
    label: `npm script \`${name}\``,
    command: `${manager} run ${name}`,
    source: "package" as const,
  }));
}

/** The repo's own package manager, from whatever it declares */
export function detectPackageManager(packageJson: Record<string, unknown>): string {
  const declared = packageJson.packageManager;
  if (typeof declared === "string" && declared.trim()) {
    return declared.trim().split("@")[0]!;
  }
  return "npm";
}

/**
 * Reads fenced commands out of an `AGENTS.md`-style file: a fenced block
 * is taken as a check list when it sits under a heading that names
 * checks/verification/tests, so ordinary code samples are not mistaken
 * for commands.
 */
/**
 * Section headings whose contents count as checks. Stems, not words: a
 * heading says "Checks" and "Verification" far more often than "check".
 */
const SECTION_RE = /\b(check|verif|test|build|lint|quality)/i;

/**
 * What a line must start with to be a command rather than prose. This is
 * the gate that keeps "- Run the tests manually before shipping" out of
 * the check list.
 */
const COMMAND_RE =
  /^(?:\/\.|npm|pnpm|yarn|bun|npx|node|deno|make|cmake|cargo|go|mvn|gradle|dotnet|python3?|pytest|uv|poetry|php|composer|bundle|rake|ruby|swift|xcodebuild)\b/i;

export function checksFromAgentsMd(raw: string | null | undefined): DeclaredCheck[] {
  if (!raw || !raw.trim()) return [];
  const commands: string[] = [];
  let inRelevantSection = false;
  let fence: string[] | null = null;

  const pushCommand = (line: string) => {
    const cleaned = line
      .trim()
      .replace(/^[-*]\s*/, "")
      .replace(/^[$>]\s*/, "")
      .trim();
    // A fully backticked line is a command even with prose around it in
    // the code block
    const unwrapped = /^`([^`]+)`$/.exec(cleaned)?.[1]?.trim() ?? cleaned;
    if (!unwrapped || unwrapped.startsWith("#")) return;
    if (!COMMAND_RE.test(unwrapped)) return;
    if (commands.includes(unwrapped)) return;
    if (commands.length < 12) commands.push(unwrapped);
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const heading = /^#{1,4}\s*(.+)$/.exec(trimmed);
    if (heading) {
      inRelevantSection = SECTION_RE.test(heading[1] ?? "");
      continue;
    }
    if (trimmed.startsWith("```")) {
      if (fence) {
        if (inRelevantSection) fence.forEach(pushCommand);
        fence = null;
      } else {
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    // Bulleted commands directly under a checks heading (no fence needed)
    if (inRelevantSection && /^[-*]\s+/.test(trimmed)) pushCommand(trimmed);
  }
  if (fence && inRelevantSection) fence.forEach(pushCommand);

  return commands.map((command) => ({
    id: checkId("agents-md", command),
    label: command,
    command,
    source: "agents-md" as const,
  }));
}

/** Deduplicates by command, keeping the strongest source */
export function mergeChecks(...lists: DeclaredCheck[][]): DeclaredCheck[] {
  const rank: Record<CheckSource, number> = { manifest: 0, package: 1, "agents-md": 2 };
  const byCommand = new Map<string, DeclaredCheck>();
  for (const list of lists) {
    for (const check of list) {
      const key = check.command.trim();
      const existing = byCommand.get(key);
      if (!existing || rank[check.source] < rank[existing.source]) byCommand.set(key, check);
    }
  }
  return [...byCommand.values()].sort(
    (a, b) => rank[a.source] - rank[b.source] || a.command.localeCompare(b.command)
  );
}

/**
 * The honest statement for a set of checks the harness cannot run. This
 * exact text goes back to the model AND into the approval gate, which is
 * the point: "these four commands exist and I did not run any of them"
 * is verifiable, while "all tests pass" is not.
 */
export function unrunChecksStatement(checks: DeclaredCheck[]): string {
  if (checks.length === 0) {
    return (
      "This repository declares no verification checks (no .intab/verify.json, no test/lint/typecheck/build scripts). " +
      "State what you checked by other means, and say plainly that nothing was executed."
    );
  }
  // This line used to read "NONE of them can be executed in this workspace —
  // there is no shell". It was true, and it was self-defeating: the tool the
  // model calls to find out what to run was telling it that running anything
  // was impossible, so it never tried, and every summary was prose. There ARE
  // tiers that run these now, and naming them here is what turns a declared
  // check into an executed one.
  return [
    `This repository declares ${checks.length} check(s). Declaring a check is not running it — none of these has been executed yet:`,
    ...checks.map((c) => `- ${c.label} → \`${c.command}\``),
    "Run them with `run_command` (it runs in the browser workspace in this tab, with no setup) or delegate to " +
      "the repository's own CI with `verify_with_ci` (the tier that covers Python, Rust, Docker and service-backed projects, " +
      "once the branch is pushed).",
    "Until one of those returns a passing result, say explicitly which of these you did NOT run, and hand the user the commands above.",
  ].join("\n");
}

/** One-line summary for a tool result / gate warning */
export function summarizeChecks(checks: DeclaredCheck[]): string {
  if (checks.length === 0) return "no declared checks";
  return `${checks.length} declared check(s): ${checks.map((c) => c.label).join(", ")}`;
}
