// ============================================================
// Env Doctor Tests — The Verdict Is The Product
// ============================================================
// The doctor exists so the workspace can say WHY a repo cannot connect
// before the dev server dies saying it. Every test here pins one sentence
// of that verdict: which keys the code wants, which the repo itself
// answers, which only the user can answer, and which are physics.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  bareClientReadsOf,
  diagnoseEnv,
  keysWithSourcesOf,
  referencedEnvKeysOf,
  suggestableValuesOf,
} from "./env-doctor";

const file = (path: string, content: string) => ({ path, content });

describe("referencedEnvKeysOf — the repo's true key list", () => {
  it("reads every shape the code accesses env through", () => {
    const keys = referencedEnvKeysOf([
      file("src/client.ts", `const url = import.meta.env.VITE_SUPABASE_URL;\nconst key = import.meta.env["VITE_SUPABASE_ANON_KEY"];`),
      file("server/api.ts", `const secret = process.env.STRIPE_SECRET_KEY;\nconst region = process.env["AWS_REGION"];`),
    ]);
    expect(keys).toEqual(["AWS_REGION", "STRIPE_SECRET_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL"]);
  });

  it("does not mistake runtime facts for asks of the user", () => {
    const keys = referencedEnvKeysOf([file("next/server.ts", "const env = process.env.NODE_ENV; const p = process.env.PATH;")]);
    expect(keys).toEqual([]);
  });

  it("does not parse prose as a key reference", () => {
    const keys = referencedEnvKeysOf([file("README.md", "The process.env.API_KEY variable is documented in the guide.")]);
    // The README DOES reference it — and the doctor reporting it as needed is
    // correct, because a README naming it usually means the code wants it.
    expect(keys).toEqual(["API_KEY"]);
  });

  it("ignores node_modules — a dependency's keys are not the project's ask", () => {
    const keys = referencedEnvKeysOf([file("node_modules/left-pad/index.js", "process.env.LEFT_PAD_DEBUG")]);
    expect(keys).toEqual([]);
  });
});

describe("keysWithSourcesOf — which keys the repo itself answers", () => {
  it("a committed env file satisfies every key it defines", () => {
    const { satisfied, inferred } = keysWithSourcesOf(
      ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_MISSING_ONE"],
      [file(".env", "VITE_SUPABASE_URL=https://x.supabase.co\nVITE_SUPABASE_ANON_KEY=eyJhbGciOi")]
    );
    expect([...satisfied].sort()).toEqual(["VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_URL"]);
    expect(inferred).toEqual([]);
  });

  it("a public fallback literal in the code satisfies its own key", () => {
    const { satisfied, inferred } = keysWithSourcesOf(
      ["VITE_SUPABASE_URL"],
      [file("src/lib/supabase.ts", `const url = import.meta.env.VITE_SUPABASE_URL ?? "https://xyzcompany.supabase.co";`)]
    );
    expect([...satisfied]).toEqual(["VITE_SUPABASE_URL"]);
    expect(inferred).toEqual([{ key: "VITE_SUPABASE_URL", source: "src/lib/supabase.ts", value: "https://xyzcompany.supabase.co" }]);
  });

  it("does not satisfy a key from an endpoint that is not public-endpoint shaped", () => {
    const { satisfied } = keysWithSourcesOf(
      ["VITE_API_URL"],
      [file("src/api.ts", `const url = import.meta.env.VITE_API_URL ?? "https://internal.corp.example.com/api";`)]
    );
    expect([...satisfied]).toEqual([]);
  });

  it("never satisfies a key that is not public-by-design from a literal", () => {
    // A secret-shaped key with a fallback string is a TRAP, not a value: the
    // fallback is usually a placeholder, and storing it silently is worse
    // than asking.
    const { satisfied } = keysWithSourcesOf(
      ["STRIPE_SECRET_KEY"],
      [file("src/billing.ts", `const key = process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder";`)]
    );
    expect([...satisfied]).toEqual([]);
  });
});

describe("suggestableValuesOf — lifts public endpoints only", () => {
  it("suggests the Supabase URL a repo commits into its source", () => {
    const suggestions = suggestableValuesOf([
      file("src/lib/supabase.ts", `createClient("https://xyzcompany.supabase.co", anonKey)`),
    ]);
    expect(suggestions).toEqual({ SUPABASE_URL: "https://xyzcompany.supabase.co" });
  });

  it("never suggests a private endpoint or a non-endpoint value", () => {
    const suggestions = suggestableValuesOf([
      file("src/a.ts", `fetch("https://internal.corp.example.com/api")`),
      file("src/b.ts", `const token = "sk-live-abcdef123456";`),
    ]);
    expect(suggestions).toEqual({});
  });
});

describe("diagnoseEnv — the verdict", () => {
  const PKG = (deps: Record<string, string>) => JSON.stringify({ dependencies: deps });

  it("connects when a committed env file answers the code's keys", () => {
    const report = diagnoseEnv({
      files: [
        file("package.json", PKG({ "@supabase/supabase-js": "^2.0.0" })),
        file(".env", "VITE_SUPABASE_URL=https://x.supabase.co\nVITE_SUPABASE_ANON_KEY=eyJhbGciOi"),
        file("src/client.ts", "export const url = import.meta.env.VITE_SUPABASE_URL;"),
      ],
      packageJson: PKG({ "@supabase/supabase-js": "^2.0.0" }),
    });
    expect(report.verdict).toBe("connects");
    expect(report.missingKeys).toEqual([]);
    // The SDK note tells the reader what the project is and what it can do here.
    expect(report.findings.some((f) => f.message.includes("Supabase"))).toBe(true);
  });

  it("names the exact keys that exist nowhere, when they exist nowhere", () => {
    const report = diagnoseEnv({
      files: [
        file("package.json", "{}"),
        file("src/api.ts", "const key = import.meta.env.VITE_WEATHER_API_KEY;"),
      ],
      packageJson: "{}",
    });
    expect(report.verdict).toBe("needs-keys");
    expect(report.missingKeys).toEqual(["VITE_WEATHER_API_KEY"]);
    expect(report.findings.some((f) => f.kind === "needs-key" && f.key === "VITE_WEATHER_API_KEY")).toBe(true);
  });

  it("counts the user's stored keys as sources, and says inferred when a lift exists", () => {
    const report = diagnoseEnv({
      files: [
        file("package.json", "{}"),
        file("src/client.ts", `const url = import.meta.env.VITE_SUPABASE_URL ?? "https://xyzcompany.supabase.co";`),
      ],
      packageJson: "{}",
      storedKeys: ["VITE_SUPABASE_URL"],
    });
    // The user already stored it — so it is no longer missing, and nothing is.
    expect(report.verdict).toBe("connects");
    expect(report.missingKeys).toEqual([]);
  });

  it("reports the localhost-database shape as BLOCKED, naming the difference from a laptop", () => {
    const report = diagnoseEnv({
      files: [
        file("package.json", PKG({ pg: "^8.0.0" })),
        file("db/index.ts", `const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://user:pass@localhost:5432/app" });`),
      ],
      packageJson: PKG({ pg: "^8.0.0" }),
    });
    expect(report.verdict).toBe("blocked");
    expect(report.findings[0]?.kind).toBe("blocked");
    expect(report.findings[0]?.message).toContain("localhost");
    expect(report.findings[0]?.message).toContain("laptop");
  });

  it("does not raise the DB blocker without both a driver and a localhost connection string", () => {
    const onlyDriver = diagnoseEnv({
      files: [file("package.json", PKG({ pg: "^8.0.0" })), file("src/a.ts", "export const x = 1;")],
      packageJson: PKG({ pg: "^8.0.0" }),
    });
    expect(onlyDriver.verdict).not.toBe("blocked");
    const onlyLocalhost = diagnoseEnv({
      files: [file("package.json", "{}"), file("src/a.ts", `const url = "postgres://u:p@localhost:5432/db";`)],
      packageJson: "{}",
    });
    expect(onlyLocalhost.verdict).not.toBe("blocked");
  });

  it("says nothing is needed when the code references no keys at all", () => {
    const report = diagnoseEnv({
      files: [file("package.json", "{}"), file("src/main.ts", "document.body.textContent = 'hi';")],
      packageJson: "{}",
    });
    expect(report.verdict).toBe("connects");
    expect(report.summary).toContain("references no env keys");
  });

  it("satisfies a VITE_ read from the repo's BARE committed value — the alias twin", () => {
    // The restaurant-repo shape: .env carries SUPABASE_URL (no prefix), the
    // code reads import.meta.env.VITE_SUPABASE_URL. Before alias awareness
    // this reported a missing key and sent the agent to ask the user for a
    // value the repository itself already ships.
    const report = diagnoseEnv({
      files: [
        file("package.json", PKG({ "@supabase/supabase-js": "^2.0.0" })),
        file(".env", "SUPABASE_URL=https://x.supabase.co\nSUPABASE_ANON_KEY=eyJhbGciOi"),
        file("src/client.ts", "export const url = import.meta.env.VITE_SUPABASE_URL;"),
      ],
      packageJson: PKG({ "@supabase/supabase-js": "^2.0.0" }),
    });
    expect(report.verdict).toBe("connects");
    expect(report.missingKeys).toEqual([]);
  });

  it("reports a BARE import.meta.env read as unfixable-by-values, and blocks the verdict", () => {
    // Vite inlines only prefixed names into a browser bundle — no env source
    // (file, stored var, literal) can make this read resolve. Saying
    // "connects" here is exactly how a broken preview got declared healthy.
    const report = diagnoseEnv({
      files: [
        file("package.json", PKG({ "@supabase/supabase-js": "^2.0.0" })),
        file(".env", "SUPABASE_URL=https://x.supabase.co"),
        file("src/client.ts", "export const url = import.meta.env.SUPABASE_URL;"),
      ],
      packageJson: PKG({ "@supabase/supabase-js": "^2.0.0" }),
    });
    expect(report.missingKeys).toEqual([]);
    expect(report.findings.some((f) => f.kind === "client-read" && f.key === "SUPABASE_URL")).toBe(true);
    expect(report.verdict).toBe("blocked");
    expect(report.summary).toContain("BARE");
  });

  it("does not flag a bare read when the repo's own vite.config widens envPrefix", () => {
    // envPrefix is the laptop-shape under which a bare read inlines the
    // process env and just works — the doctor must not "fix" what is not broken.
    const report = diagnoseEnv({
      files: [
        file("package.json", "{}"),
        file("vite.config.ts", "export default defineConfig({ envPrefix: ['VITE_', 'SUPABASE_'] });"),
        file(".env", "SUPABASE_URL=https://x.supabase.co"),
        file("src/client.ts", "export const url = import.meta.env.SUPABASE_URL;"),
      ],
      packageJson: "{}",
    });
    expect(report.findings.some((f) => f.kind === "client-read")).toBe(false);
    expect(report.verdict).toBe("connects");
  });

  it("never reports Vite's own import.meta.env members as missing keys", () => {
    const report = diagnoseEnv({
      files: [file("package.json", "{}"), file("src/main.ts", "const mode = import.meta.env.MODE; const dev = import.meta.env.DEV;")],
      packageJson: "{}",
    });
    expect(report.missingKeys).toEqual([]);
    expect(report.verdict).toBe("connects");
  });

  it("bounds the scan so a huge repo cannot burn the tab reading everything", () => {
    const big = "x".repeat(3_000_000);
    const report = diagnoseEnv({
      files: [file("package.json", "{}"), file("generated/huge.ts", big)],
      packageJson: "{}",
    });
    // The bound makes the scan safe, not wrong: the huge file's absence from
    // the verdict must not crash or hang the call.
    expect(report.referencedKeys).toEqual([]);
  });
});
