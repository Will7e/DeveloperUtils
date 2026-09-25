// ============================================================
// License Report — What The Manifests Say The Project May Ship
// ============================================================
// The pure half of the `license_check` tool: manifest text in, a license
// report out. It reads ONLY what the workspace holds — no registry
// fetches, no advisory lookups — and it says so in the result, because a
// half-report that presents itself as a full audit is worse than a
// limited one that is honest about its edges.
//
// Where the license string comes from, in order: the lockfile's
// per-package metadata when present (npm writes `license` into
// packages[] for installed deps), then the manifest's own `license`
// field (the project's declaration for itself), then unknown. That
// ordering is the difference between "declared" and "guessed", and the
// result labels which half each row came from.
//
// Pure: text in, data out. No network, no store.

/** Licenses most teams disallow. GPL-family copyleft plus the unknowns. */
const RESTRICTED = /\b(AGPL|GPL|LGPL|SSPL|EUPL|OSL|SISSL|CDDL|EPL)\b/i;
const PERMISSIVE = /\b(MIT|ISC|BSD|Apache|Unlicense|WTFPL|Zlib|CC0-1\.0|CC-BY-\d)/i;

export interface LicenseRow {
  name: string;
  version?: string;
  license: string;
  /** "lockfile" = recorded at install time; "manifest" = the project's own declaration */
  source: "lockfile" | "manifest" | "unknown";
  /** True when the license matched the restricted set (or could not be read) */
  flag: "restricted" | "unknown" | "ok";
}

export interface LicenseReport {
  manifestFound: boolean;
  dependencies: LicenseRow[];
  devDependencies: LicenseRow[];
  flagged: string[];
  note: string;
}

interface LockfilePackage {
  name?: string;
  version?: string;
  license?: string;
}

/** Extracts a JSON object's top-level string field, tolerating missing keys */
function field(json: Record<string, unknown>, key: string): string | undefined {
  const value = json[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Builds the report from manifest + lockfile text. Either may be null —
 * a workspace mid-change often has one and not the other.
 */
export function licenseReport(
  manifestText: string | null,
  lockText: string | null
): LicenseReport {
  // The lockfile's packages table is keyed "node_modules/<name>" and
  // carries the license npm recorded at install time.
  const lockLicenses = new Map<string, { version?: string; license?: string }>();
  if (lockText) {
    try {
      const lock = JSON.parse(lockText) as { packages?: Record<string, LockfilePackage> };
      for (const [key, meta] of Object.entries(lock.packages ?? {})) {
        if (!key || key === "") continue;
        const name = key.startsWith("node_modules/") ? key.slice("node_modules/".length) : key;
        if (name.includes("node_modules/")) continue; // nested dep — direct set only
        if (meta && (meta.license || meta.version)) {
          lockLicenses.set(name, { version: meta.version, license: meta.license });
        }
      }
    } catch {
      // An unparseable lockfile is a common mid-edit state; report from what parses.
    }
  }

  let manifestFound = false;
  let deps: Array<{ name: string; kind: "dependencies" | "devDependencies" }> = [];
  if (manifestText) {
    try {
      const manifest = JSON.parse(manifestText) as Record<string, unknown>;
      manifestFound = true;
      for (const kind of ["dependencies", "devDependencies"] as const) {
        const section = manifest[kind];
        if (section && typeof section === "object" && !Array.isArray(section)) {
          for (const name of Object.keys(section as Record<string, unknown>)) {
            deps.push({ name, kind });
          }
        }
      }
    } catch {
      // Handled by manifestFound staying false below.
    }
  }

  const toRow = (name: string, isDev: boolean): LicenseRow => {
    // Deliberately NO fallback to the project's own `license` field: that
    // declares the PROJECT's license, and borrowing it for its dependencies
    // would present a guess as a fact. No lockfile entry = unknown.
    const lock = lockLicenses.get(name);
    const license = lock?.license ?? "";
    const source: LicenseRow["source"] = lock?.license ? "lockfile" : "unknown";
    let flag: LicenseRow["flag"] = "ok";
    if (!license || license === "UNLICENSED") flag = "unknown";
    else if (RESTRICTED.test(license)) flag = "restricted";
    else if (!PERMISSIVE.test(license)) flag = "unknown";
    return {
      name,
      ...(lock?.version ? { version: lock.version } : {}),
      license: license || "unknown",
      source,
      flag,
      // Dev-only rows are flagged but never urgent; callers see `dev` too.
      ...(isDev ? { dev: true } : {}),
    } as LicenseRow;
  };

  const rows = deps.map((d) => toRow(d.name, d.kind === "devDependencies"));
  const flagged = rows
    .filter((r) => r.flag !== "ok" && !("dev" in r))
    .map((r) => `${r.name}: ${r.license}${r.flag === "restricted" ? " (restricted family)" : " (license unknown)"}`);
  const lockless = rows.filter((r) => r.source === "unknown" && !("dev" in r)).length;

  return {
    manifestFound,
    dependencies: rows.filter((r) => !("dev" in r)),
    devDependencies: rows.filter((r) => "dev" in r) as LicenseRow[],
    flagged,
    // A lockfile-less read cannot name ANY dependency's license honestly.
    ...(lockless > 0 && !lockText
      ? { lockfileFound: false as const }
      : {}),
    note:
      "Licenses come from the lockfile, where the package manager recorded what was installed. Without it the license is reported as unknown rather than guessed. " +
      "This is a DECLARED-license read, not an audit: it does not fetch registries, resolve transitive dependencies, or check advisories.",
  };
}
