// ============================================================
// Preview Environment — Regression Suite
// ============================================================
// The failure this guards against is quiet and total: a Vite app reads
// `import.meta.env.VITE_*` at module scope, and with no define map that is
// `undefined`, so the app throws while mounting and the pane shows a page
// on which nothing works.
//
// The second promise is a security one — only VITE_-prefixed keys are
// exposed, and no diagnostic ever prints a value from a .env file.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildDefineMap,
  buildPreviewEnv,
  describeEnv,
  envFileCandidates,
  parseDotEnv,
  resolveDotEnv,
} from "./env";

describe("parseDotEnv", () => {
  it("parses the forms that appear in real .env files", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "",
        "VITE_API_URL=https://api.example.com",
        "export VITE_FLAG=1",
        'VITE_QUOTED="value with spaces"',
        "VITE_SINGLE='single quoted'",
        "VITE_ESCAPED=\"line1\\nline2\"",
        "  VITE_PADDED = spaced  ",
        "VITE_TRAILING=value # trailing comment",
        "NOT_A_KEY",
        "1INVALID=x",
      ].join("\n")
    );
    expect(parsed.values.VITE_API_URL).toBe("https://api.example.com");
    expect(parsed.values.VITE_FLAG).toBe("1");
    expect(parsed.values.VITE_QUOTED).toBe("value with spaces");
    expect(parsed.values.VITE_SINGLE).toBe("single quoted");
    expect(parsed.values.VITE_ESCAPED).toBe("line1\nline2");
    expect(parsed.values.VITE_PADDED).toBe("spaced");
    expect(parsed.values.VITE_TRAILING).toBe("value");
    expect(parsed.values.NOT_A_KEY).toBeUndefined();
    expect(parsed.values["1INVALID"]).toBeUndefined();
  });

  it("keeps a # inside quotes", () => {
    expect(parseDotEnv('VITE_X="a#b"').values.VITE_X).toBe("a#b");
  });

  it("records a declared-but-empty key as empty rather than set", () => {
    const parsed = parseDotEnv("VITE_EMPTY=\nVITE_SET=1");
    expect(parsed.empty).toEqual(["VITE_EMPTY"]);
    expect(parsed.values.VITE_EMPTY).toBeUndefined();
    expect(parsed.values.VITE_SET).toBe("1");
  });

  it("handles nothing", () => {
    expect(parseDotEnv(null).values).toEqual({});
    expect(parseDotEnv("").values).toEqual({});
  });
});

describe("resolveDotEnv", () => {
  it("applies Vite's precedence: later, more specific files win", () => {
    const files = new Map([
      [".env", "VITE_A=base\nVITE_B=base"],
      [".env.production", "VITE_A=prod"],
    ]);
    const { values, read } = resolveDotEnv(files, "production");
    expect(values.VITE_A).toBe("prod");
    expect(values.VITE_B).toBe("base");
    expect(read).toEqual([".env", ".env.production"]);
  });

  it("lets .env.local override .env", () => {
    const files = new Map([
      [".env", "VITE_A=base"],
      [".env.local", "VITE_A=local"],
    ]);
    expect(resolveDotEnv(files, "production").values.VITE_A).toBe("local");
  });

  it("treats an empty declaration as unsetting the key", () => {
    const files = new Map([
      [".env", "VITE_A=base"],
      [".env.production", "VITE_A="],
    ]);
    expect(resolveDotEnv(files, "production").values.VITE_A).toBeUndefined();
  });

  it("ignores files that are not in the repository", () => {
    expect(resolveDotEnv(new Map(), "production").read).toEqual([]);
  });

  it("lists the candidate files in precedence order", () => {
    expect(envFileCandidates("production")).toEqual([
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
    ]);
  });
});

describe("buildPreviewEnv", () => {
  const envFiles = new Map([
    [
      ".env",
      [
        "VITE_API_URL=https://api.example.com",
        "DATABASE_PASSWORD=hunter2",
        "VITE_STRIPE_SECRET_KEY=sk_live_should_never_be_exposed_verbatim",
      ].join("\n"),
    ],
  ]);

  it("exposes only VITE_-prefixed keys, plus the built-ins", () => {
    const env = buildPreviewEnv({ envFiles });
    expect(env.exposed.VITE_API_URL).toBe("https://api.example.com");
    expect(env.exposed.DATABASE_PASSWORD).toBeUndefined();
    expect(env.exposed.MODE).toBe("production");
    expect(env.exposed.DEV).toBe(false);
    expect(env.exposed.PROD).toBe(true);
    expect(env.exposed.SSR).toBe(false);
    expect(env.exposed.BASE_URL).toBe("/");
  });

  it("names withheld keys so the reason is answerable", () => {
    expect(buildPreviewEnv({ envFiles }).withheld).toEqual(["DATABASE_PASSWORD"]);
  });

  it("flags secret-shaped VITE_ keys without leaking their values", () => {
    const env = buildPreviewEnv({ envFiles });
    expect(env.secretLike).toEqual(["VITE_STRIPE_SECRET_KEY"]);
  });

  it("describes itself by KEY NAME ONLY — never a value", () => {
    const text = describeEnv(buildPreviewEnv({ envFiles })) ?? "";
    expect(text).toContain(".env");
    expect(text).toContain("VITE_STRIPE_SECRET_KEY");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk_live");
    expect(text).not.toContain("api.example.com");
  });

  it("reports .env files that exist in the repo but were not loaded", () => {
    const env = buildPreviewEnv({
      envFiles: new Map(),
      treePaths: [".env.local", ".env.production.local", "src/main.tsx"],
    });
    expect(env.skipped).toEqual([".env.local", ".env.production.local"]);
    expect(describeEnv(env)).toContain("skipped");
  });

  it("says nothing when the repository has no env files", () => {
    expect(describeEnv(buildPreviewEnv({}))).toBeNull();
  });

  it("can be built for a development mode without pretending otherwise", () => {
    const env = buildPreviewEnv({ mode: "development" });
    expect(env.exposed.DEV).toBe(true);
    expect(env.exposed.PROD).toBe(false);
  });
});

describe("buildDefineMap", () => {
  it("defines import.meta.env as a whole object, so computed access works too", () => {
    const define = buildDefineMap(
      buildPreviewEnv({ envFiles: new Map([[".env", "VITE_A=1"]]) })
    );
    const value = JSON.parse(define["import.meta.env"] as string) as Record<string, unknown>;
    expect(value.VITE_A).toBe("1");
    expect(value.MODE).toBe("production");
  });

  it("neutralizes import.meta.hot, which cannot exist in a static bundle", () => {
    const define = buildDefineMap(buildPreviewEnv({}));
    expect(define["import.meta.hot"]).toBe("undefined");
  });

  it("agrees with itself about NODE_ENV", () => {
    expect(buildDefineMap(buildPreviewEnv({}))["process.env.NODE_ENV"]).toBe('"production"');
    expect(
      buildDefineMap(buildPreviewEnv({ mode: "development" }))["process.env.NODE_ENV"]
    ).toBe('"development"');
  });
});
