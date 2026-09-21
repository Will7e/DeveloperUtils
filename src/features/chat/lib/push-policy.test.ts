// ============================================================
// Push Policy — Gate Tests
// ============================================================
// The rules that matter: a credential blocks, a high-blast-radius file
// warns, and a documented example key is NOT treated as a leak (a gate
// that cries wolf gets ignored, which is worse than no gate).

import { describe, it, expect } from "vitest";
import { assessPushPolicy, findSecret, policyWarnings } from "./push-policy";

function files(paths: Array<[string, string | null]>) {
  return { files: paths.map(([path, content]) => ({ path, content })) };
}

describe("assessPushPolicy — credentials", () => {
  it("blocks a hard-coded cloud key", () => {
    const report = assessPushPolicy(
      files([["src/config.ts", 'const K = "AKIA3XQ7ZR2MKP9TUVWY";']])
    );
    expect(report.blocked).toBe(true);
    expect(report.findings[0]!.code).toBe("secret-detected");
    expect(report.findings[0]!.paths).toEqual(["src/config.ts"]);
  });

  it("blocks a private key block", () => {
    const report = assessPushPolicy(
      files([["deploy/key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],])
    );
    expect(report.blocked).toBe(true);
  });

  it("blocks a hard-coded password assignment", () => {
    const report = assessPushPolicy(files([["src/db.ts", 'password: "hunter2vertical"']]));
    expect(report.blocked).toBe(true);
  });

  it("never echoes the secret value back", () => {
    const report = assessPushPolicy(
      files([["src/a.ts", 'const t = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";']])
    );
    expect(report.blockReason).not.toContain("ABCDEFGHIJ");
  });

  it("tolerates documented examples and env reads", () => {
    const report = assessPushPolicy(
      files([
        ["README.md", "Use `AKIAIOSFODNN7EXAMPLE` as the sample access key."],
        ["src/a.ts", "const key = process.env.OPENAI_API_KEY;"],
        ["src/b.ts", 'const key = "your-api-key-goes-here";'],
        ["src/c.ts", 'password: "xxxx-redacted"'],
      ])
    );
    expect(report.blocked).toBe(false);
    expect(report.findings).toHaveLength(0);
  });

  it("does not scan deletions — removing a secret is a fix", () => {
    const report = assessPushPolicy(files([["src/old.ts", null]]));
    expect(report.blocked).toBe(false);
  });
});

describe("findSecret", () => {
  it("identifies the credential family", () => {
    const found = findSecret('token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"');
    expect(found?.label).toMatch(/GitHub token/);
  });

  it("returns null for ordinary code", () => {
    expect(findSecret("const answer = 42; // no secrets here")).toBeNull();
  });
});

describe("assessPushPolicy — protected paths", () => {
  it("warns about CI workflows without blocking", () => {
    const report = assessPushPolicy(
      files([["src/index.ts", "console.log(1)"], [".github/workflows/ci.yml", "on: push"]])
    );
    expect(report.blocked).toBe(false);
    const policy = report.findings.find((f) => f.code === "protected-path");
    expect(policy?.severity).toBe("warn");
    expect(policy?.message).toContain(".github/workflows/ci.yml");
    expect(policy?.message).toMatch(/secrets/);
  });

  it("warns about lockfiles, manifests and migrations", () => {
    const report = assessPushPolicy(
      files([
        ["package.json", "{}"],
        ["package-lock.json", "{}"],
        ["db/migrations/001_init.sql", "create table t();"],
      ])
    );
    const codes = report.findings.filter((f) => f.code === "protected-path");
    expect(codes.length).toBeGreaterThanOrEqual(3);
    expect(report.blocked).toBe(false);
  });

  it("stays quiet for ordinary source edits", () => {
    const report = assessPushPolicy(
      files([["src/App.tsx", "export default 1"], ["src/util.ts", "export const x = 2"]])
    );
    expect(report.findings).toHaveLength(0);
  });
});

describe("assessPushPolicy — reviewability", () => {
  it("warns when the change set is too large to review", () => {
    const report = assessPushPolicy({
      files: Array.from({ length: 61 }, (_, i) => ({ path: `src/f${i}.ts`, content: "x" })),
      additions: 10,
      deletions: 2,
    });
    expect(report.findings.some((f) => f.code === "oversized-change-set")).toBe(true);
  });

  it("warns on a huge line count even with few files", () => {
    const report = assessPushPolicy({
      files: [{ path: "src/big.ts", content: "x" }],
      additions: 3_500,
      deletions: 900,
    });
    expect(report.findings.some((f) => f.code === "oversized-change-set")).toBe(true);
  });
});

describe("policyWarnings", () => {
  it("surfaces advisory findings and drops the blocking one", () => {
    const report = assessPushPolicy(
      files([
        ["package.json", "{}"],
        ["src/a.ts", 'const K = "AKIA3XQ7ZR2MKP9TUVWY";'],
      ])
    );
    const warnings = policyWarnings(report);
    expect(warnings.every((w) => w.kind === "policy")).toBe(true);
    expect(warnings.some((w) => w.message.includes("package.json"))).toBe(true);
    expect(warnings.some((w) => /credential/.test(w.message))).toBe(false);
  });
});
