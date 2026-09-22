// ============================================================
// Verification Contract — Discovery Tests
// ============================================================
// The whole value of this module is that its output is CHECKABLE: the
// commands it names must be the repo's real commands, in a sensible
// order, and it must never invent one.

import { describe, it, expect } from "vitest";
import {
  checksFromAgentsMd,
  checksFromPackageJson,
  detectPackageManager,
  mergeChecks,
  parseVerifyManifest,
  summarizeChecks,
  unrunChecksStatement,
} from "./verify-contract";

describe("parseVerifyManifest", () => {
  it("reads an object list", () => {
    const { checks } = parseVerifyManifest(
      JSON.stringify({
        checks: [
          { id: "unit", label: "Unit tests", command: "npm test" },
          { command: "npm run lint" },
        ],
      })
    );
    expect(checks.map((c) => c.command)).toEqual(["npm test", "npm run lint"]);
    expect(checks[0]!.label).toBe("Unit tests");
    expect(checks[0]!.source).toBe("manifest");
    expect(checks[1]!.label).toBe("npm run lint");
  });

  it("reads a plain string list", () => {
    const { checks } = parseVerifyManifest('{"checks":["npm test","npm run build"]}');
    expect(checks.map((c) => c.command)).toEqual(["npm test", "npm run build"]);
  });

  it("reads the single-check shorthand", () => {
    expect(parseVerifyManifest('{"check":"make verify"}').checks[0]!.command).toBe("make verify");
  });

  it("reports malformed JSON instead of throwing", () => {
    const { checks, error } = parseVerifyManifest("{ not json");
    expect(checks).toEqual([]);
    expect(error).toMatch(/not valid JSON/);
  });

  it("reports an empty manifest", () => {
    expect(parseVerifyManifest('{"checks":[]}').error).toMatch(/declares no checks/);
    expect(parseVerifyManifest(null).checks).toEqual([]);
  });
});

describe("checksFromPackageJson", () => {
  const pkg = JSON.stringify({
    packageManager: "pnpm@9.1.0",
    scripts: {
      dev: "vite",
      start: "node .",
      format: "prettier --write .",
      build: "tsc -b && vite build",
      test: "vitest run",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      "test:e2e": "playwright test",
    },
  });

  it("keeps verification scripts and drops dev/start/format", () => {
    const labels = checksFromPackageJson(pkg).map((c) => c.command);
    expect(labels.some((l) => l.includes("dev"))).toBe(false);
    expect(labels.some((l) => l.includes("start"))).toBe(false);
    expect(labels.some((l) => l.includes("format"))).toBe(false);
    expect(labels).toContain("pnpm run test");
    expect(labels).toContain("pnpm run test:e2e");
  });

  it("orders typecheck and lint before build", () => {
    const labels = checksFromPackageJson(pkg).map((c) => c.command);
    expect(labels.indexOf("pnpm run typecheck")).toBeLessThan(labels.indexOf("pnpm run test"));
    expect(labels.indexOf("pnpm run test")).toBeLessThan(labels.indexOf("pnpm run build"));
  });

  it("uses the repo's own package manager", () => {
    expect(checksFromPackageJson(pkg)[0]!.command.startsWith("pnpm ")).toBe(true);
    expect(checksFromPackageJson('{"scripts":{"test":"x"}}')[0]!.command).toBe("npm run test");
  });

  it("survives a package.json with no scripts", () => {
    expect(checksFromPackageJson("{}")).toEqual([]);
    expect(checksFromPackageJson("// not json")).toEqual([]);
  });

  it("detects the manager from packageManager", () => {
    expect(detectPackageManager({ packageManager: "yarn@4.0.0" })).toBe("yarn");
    expect(detectPackageManager({})).toBe("npm");
  });
});

describe("checksFromAgentsMd", () => {
  it("reads a fenced block under a checks heading", () => {
    const md = ["# AGENTS", "", "## Checks", "", "```bash", "npm run typecheck", "$ npm test", "```"].join("\n");
    expect(checksFromAgentsMd(md).map((c) => c.command)).toEqual(["npm run typecheck", "npm test"]);
  });

  it("ignores a fenced block under an unrelated heading", () => {
    const md = ["# AGENTS", "", "## Usage", "```bash", "npm install", "```"].join("\n");
    expect(checksFromAgentsMd(md)).toEqual([]);
  });

  it("reads bulleted commands too", () => {
    const md = ["## Verification", "- `npm test`", "* npm run lint"].join("\n");
    expect(checksFromAgentsMd(md).map((c) => c.command)).toEqual(["npm test", "npm run lint"]);
  });

  it("returns nothing for missing input", () => {
    expect(checksFromAgentsMd(null)).toEqual([]);
    expect(checksFromAgentsMd("")).toEqual([]);
  });
});

describe("mergeChecks", () => {
  it("deduplicates by command and prefers the strongest source", () => {
    const manifest = parseVerifyManifest('{"checks":["npm test"]}').checks;
    const fromDocs = checksFromAgentsMd("## Checks\n```\nnpm test\n```");
    const merged = mergeChecks(manifest, fromDocs);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("manifest");
  });

  it("keeps distinct commands from every source", () => {
    const merged = mergeChecks(
      parseVerifyManifest('{"checks":["npm test"]}').checks,
      checksFromPackageJson('{"scripts":{"lint":"eslint ."}}'),
      checksFromAgentsMd("## Checks\n```\nmake verify\n```")
    );
    expect(merged.map((c) => c.command).sort()).toEqual(["make verify", "npm run lint", "npm test"]);
  });
});

describe("unrunChecksStatement", () => {
  it("names every command and says plainly that none has run", () => {
    const statement = unrunChecksStatement(
      checksFromPackageJson('{"scripts":{"test":"vitest","lint":"eslint ."}}')
    );
    expect(statement).toContain("Declaring a check is not running it");
    expect(statement).toContain("npm run test");
    expect(statement).toContain("npm run lint");
  });

  it("points at the tiers that CAN run them", () => {
    // This statement used to say the checks were impossible to execute here.
    // The tool that tells the model what to run was telling it that running
    // anything was impossible, so nothing ever ran and every summary was
    // prose. Naming the tiers is what makes the declaration actionable.
    const statement = unrunChecksStatement(
      checksFromPackageJson('{"scripts":{"test":"vitest"}}')
    );
    expect(statement).toContain("run_command");
    expect(statement).toContain("verify_with_ci");
    expect(statement).not.toContain("no shell");
  });

  it("is honest when the repo declares nothing", () => {
    expect(unrunChecksStatement([])).toMatch(/no verification checks/i);
  });
});

describe("summarizeChecks", () => {
  it("counts and names", () => {
    const summary = summarizeChecks(checksFromPackageJson('{"scripts":{"test":"vitest"}}'));
    expect(summary).toContain("1 declared check");
  });

  it("handles the empty case", () => {
    expect(summarizeChecks([])).toBe("no declared checks");
  });
});
