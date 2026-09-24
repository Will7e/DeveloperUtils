// ============================================================
// Project Fingerprint — What This Project IS, Read Once
// ============================================================
// An agent that has to ask "how do I run your tests?" has already wasted a
// turn, and one that guesses `npm test` in a pnpm monorepo wastes several.
// The facts it needs are cheap, deterministic, and already in the tree:
//
//   • what the project is written in (by file count, which is what makes a
//     "the main language here is TypeScript" statement honest);
//   • which package manager owns it (the lockfile, not a guess);
//   • which test framework runs here, and how many test files exist;
//   • where the entry points are.
//
// Everything here is a pure function of a path list plus an optional manifest
// text, so it is unit-testable without a repository, and byte-stable for a
// given tree — which is what lets it sit in the cached prompt prefix. It is
// derived from the BASE tree (the file paths the workspace was seeded with),
// never from the agent's own edits, so it cannot churn mid-conversation and
// invalidate the provider's cache.

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  cs: "C#",
  php: "PHP",
  swift: "Swift",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  css: "CSS",
  scss: "CSS",
  sass: "CSS",
  less: "CSS",
  html: "HTML",
  vue: "Vue",
  svelte: "Svelte",
  md: "Markdown",
  mdx: "Markdown",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  tf: "Terraform",
};

/** Package manager, decided by the lockfile the project actually ships */
const PACKAGE_MANAGER_BY_LOCKFILE: ReadonlyArray<[RegExp, string]> = [
  [/^(.*\/)?pnpm-lock\.yaml$/, "pnpm"],
  [/^(.*\/)?yarn\.lock$/, "yarn"],
  [/^(.*\/)?bun\.lockb?$/, "bun"],
  [/^(.*\/)?package-lock\.json$/, "npm"],
  [/^(.*\/)?poetry\.lock$/, "poetry"],
  [/^(.*\/)?Pipfile\.lock$/, "pipenv"],
  [/^(.*\/)?requirements\.txt$/, "pip"],
  [/^(.*\/)?Cargo\.lock$/, "cargo"],
  [/^(.*\/)?go\.sum$/, "go modules"],
  [/^(.*\/)?Gemfile\.lock$/, "bundler"],
  [/^(.*\/)?composer\.lock$/, "composer"],
];

/** Test runners, in the order a manifest mentioning several should be read */
const TEST_FRAMEWORKS: readonly string[] = [
  "vitest",
  "jest",
  "@playwright/test",
  "cypress",
  "mocha",
  "ava",
  "pytest",
  "unittest",
  "rspec",
  "go test",
];

/** Files that are an entry point when present, in priority order */
const ENTRY_POINT_PATTERNS: readonly RegExp[] = [
  /^(.*\/)?src\/main\.(tsx|ts|jsx|js)$/,
  /^(.*\/)?src\/index\.(tsx|ts|jsx|js)$/,
  /^(.*\/)?src\/App\.(tsx|ts|jsx|js)$/,
  /^(.*\/)?main\.(tsx|ts|jsx|js)$/,
  /^(.*\/)?App\.(tsx|ts|jsx|js)$/,
  /^(.*\/)?(app|server|index)\.(py)$/,
  /^(.*\/)?cmd\/[^/]+\/main\.go$/,
  /^(.*\/)?src\/main\.rs$/,
  /^(.*\/)?index\.html$/,
];

const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$/;

/**
 * True for a path that is a test by convention.
 *
 * Exported because more than one reader needs the same answer — the fingerprint
 * counts test files, and the completion gate asks whether a change set includes
 * one — and two copies of this regex is how "the agent added a test" and "the
 * project has tests" start disagreeing.
 */
export function isTestPath(path: string): boolean {
  return TEST_FILE_PATTERN.test(path);
}

/**
 * True for a path whose change needs no execution to be trusted.
 *
 * Documentation, manifests, lockfiles and assets: the check-on-every-edit rule
 * must not fire on them, or it becomes noise the model learns to ignore.
 */
export function isNonSourcePath(path: string): boolean {
  return /\.(?:md|mdx|txt|json|ya?ml|toml|lock|csv|svg|png|jpe?g|gif|ico|webp)$/i.test(path);
}

export interface ProjectFingerprint {
  /** Top languages by file count, most first (at most four) */
  languages: Array<{ name: string; files: number }>;
  /** The lockfile's package manager, or null when nothing declares one */
  packageManager: string | null;
  /** Test framework named by the manifest, if one is named */
  testFramework: string | null;
  /** Files that look like tests, by path convention */
  testFiles: number;
  /** Entry-point candidates that exist, in pattern priority order */
  entryPoints: string[];
}

/** Basename-level extension of a path ("" when there is none) */
function extensionOf(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match?.[1]?.toLowerCase() ?? "";
}

/**
 * Builds the fingerprint from a path list and, optionally, the text of the
 * project's package.json (used only to spot a test framework — nothing else
 * about the manifest is needed here).
 */
export function buildFingerprint(
  paths: readonly string[],
  manifest?: string
): ProjectFingerprint {
  const byLanguage = new Map<string, number>();
  let testFiles = 0;
  let packageManager: string | null = null;
  const entryPoints: string[] = [];

  for (const path of paths) {
    const language = LANGUAGE_BY_EXTENSION[extensionOf(path)];
    if (language) byLanguage.set(language, (byLanguage.get(language) ?? 0) + 1);
    if (TEST_FILE_PATTERN.test(path)) testFiles += 1;
    if (packageManager === null) {
      for (const [pattern, manager] of PACKAGE_MANAGER_BY_LOCKFILE) {
        if (pattern.test(path)) {
          packageManager = manager;
          break;
        }
      }
    }
    if (entryPoints.length < 4 && ENTRY_POINT_PATTERNS.some((p) => p.test(path))) {
      entryPoints.push(path);
    }
  }

  const languages = [...byLanguage.entries()]
    .map(([name, files]) => ({ name, files }))
    // Source languages first among ties: a project with equal JSON and TS
    // counts is a TypeScript project, not a JSON one.
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 4);

  let testFramework: string | null = null;
  if (manifest) {
    testFramework = TEST_FRAMEWORKS.find((name) => manifest.includes(`"${name}"`)) ?? null;
    if (!testFramework && /"pytest"/.test(manifest)) testFramework = "pytest";
  }

  return { languages, packageManager, testFramework, testFiles, entryPoints };
}

/**
 * One line for the prompt, or "" when the tree says nothing useful.
 *
 * Deliberately conservative: it states only what the files prove, and it says
 * nothing at all rather than guessing a test command it has not seen declared
 * (a wrong "run npm test" is worse than no advice at all).
 */
export function describeFingerprint(fingerprint: ProjectFingerprint): string {
  const parts: string[] = [];
  if (fingerprint.languages.length > 0) {
    parts.push(
      fingerprint.languages.map((l) => `${l.name} (${l.files} file${l.files === 1 ? "" : "s"})`).join(", ")
    );
  }
  if (fingerprint.packageManager) parts.push(fingerprint.packageManager);
  if (fingerprint.testFramework) {
    parts.push(
      `tests: ${fingerprint.testFramework}${
        fingerprint.testFiles > 0 ? `, ${fingerprint.testFiles} test file${fingerprint.testFiles === 1 ? "" : "s"}` : ""
      }`
    );
  } else if (fingerprint.testFiles > 0) {
    parts.push(`${fingerprint.testFiles} test file${fingerprint.testFiles === 1 ? "" : "s"} (runner not declared)`);
  }
  if (fingerprint.entryPoints.length > 0) {
    parts.push(`entry: ${fingerprint.entryPoints.slice(0, 3).join(", ")}`);
  }
  if (parts.length === 0) return "";
  return `Project fingerprint: ${parts.join(" · ")}.`;
}
