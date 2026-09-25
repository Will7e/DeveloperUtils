// ============================================================
// Runtime Env Tests — The Store Between The Paste And The Spawn
// ============================================================
// This store is the missing configuration layer: a key the user pasted once
// has to reach every later spawn, survive the conversation it was typed in,
// and never leak into a file, a mount, or a report. The tests pin the merge
// precedence, the per-repo isolation, and the shape of the parser the
// conversational path depends on.
// ============================================================

import { describe, expect, it } from "vitest";
import {
  committedEnvVarsOfTree,
  mergeContainerEnv,
  parseEnvText,
  repoEnvKeys,
  resetRuntimeEnvForTest,
  setRepoEnvFromText,
  setRepoEnvVar,
  spawnEnvFor,
} from "./runtime-env";

/** A tree shaped the way `planMount` builds one, with a committed env file in it */
const TREE_WITH_ENV = {
  ".env": { file: { contents: "SUPABASE_URL=https://x.supabase.co\nSUPABASE_ANON_KEY=eyJhbGciOi\n" } },
  src: { directory: { "main.ts": { file: { contents: "console.log(1)" } } } },
};

const BASE = { CI: "1", NO_COLOR: "1", TERM: "dumb" };

describe("committedEnvVarsOfTree — the file half of what a laptop does", () => {
  it("hands every committed env-file variable to the process env, prefix or not", () => {
    // The non-`VITE_` case: Vite never inlines a bare name into a browser
    // bundle — laptop code reaches it through `process.env` of the dev server
    // itself. The workspace reproduces that by making these REAL env vars of
    // the spawn.
    const vars = committedEnvVarsOfTree(TREE_WITH_ENV);
    expect(vars).toEqual({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "eyJhbGciOi" });
  });

  it("reads nested env files and skips non-env files", () => {
    const vars = committedEnvVarsOfTree({
      config: { directory: { ".env.production": { file: { contents: "API_BASE=https://prod" } } } },
      "README.md": { file: { contents: "FAKE=value" } },
    });
    expect(vars).toEqual({ API_BASE: "https://prod" });
  });
});

describe("spawnEnvFor — the full precedence the spawn sites share", () => {
  it("base < committed-file vars < user-stored vars, in that order", async () => {
    resetRuntimeEnvForTest();
    await setRepoEnvVar("acme", "widgets", "SUPABASE_URL", "https://user-override.supabase.co");
    const env = await spawnEnvFor({ CI: "1" }, "acme/widgets", TREE_WITH_ENV);
    expect(env.CI).toBe("1");
    // The file's variable reaches the process even without a prefix...
    expect(env.SUPABASE_ANON_KEY).toBe("eyJhbGciOi");
    // ...and the user's explicit correction outranks the file.
    expect(env.SUPABASE_URL).toBe("https://user-override.supabase.co");
  });
});

describe("parseEnvText — what a chat paste looks like", () => {
  it("reads the shapes real env files ship", () => {
    const parsed = parseEnvText(
      [
        "# a comment",
        "",
        "VITE_SUPABASE_URL=https://xyz.supabase.co",
        "export VITE_KEY=abc123",
        'QUOTED="a value with spaces"',
        "SINGLE='quoted'",
        "TRAILING=value # inline comment",
        "not a pair",
        "1BAD=nono",
      ].join("\n")
    );
    expect(parsed).toEqual({
      VITE_SUPABASE_URL: "https://xyz.supabase.co",
      VITE_KEY: "abc123",
      QUOTED: "a value with spaces",
      SINGLE: "quoted",
      TRAILING: "value",
    });
  });
});

describe("mergeContainerEnv — one precedence rule for every spawn site", () => {
  it("the repo's stored vars override the base, and nothing else does", async () => {
    resetRuntimeEnvForTest();
    await setRepoEnvVar("acme", "widgets", "VITE_SUPABASE_URL", "https://x.supabase.co");
    const env = await mergeContainerEnv(BASE, "acme/widgets");
    expect(env.CI).toBe("1");
    expect(env.VITE_SUPABASE_URL).toBe("https://x.supabase.co");
  });

  it("another repo's vars never leak across", async () => {
    resetRuntimeEnvForTest();
    await setRepoEnvVar("acme", "widgets", "VITE_A", "one");
    await setRepoEnvVar("acme", "other", "VITE_B", "two");
    const widgets = await mergeContainerEnv(BASE, "acme/widgets");
    const other = await mergeContainerEnv(BASE, "acme/other");
    expect(widgets.VITE_A).toBe("one");
    expect(widgets.VITE_B).toBeUndefined();
    expect(other.VITE_B).toBe("two");
    expect(other.VITE_A).toBeUndefined();
  });

  it("a repo with no stored env gets the plain base", async () => {
    resetRuntimeEnvForTest();
    const env = await mergeContainerEnv(BASE, "acme/fresh");
    expect(env).toEqual(BASE);
  });
});

describe("setRepoEnvVar — the single-variable path", () => {
  it("round-trips a set and reports what changed", async () => {
    resetRuntimeEnvForTest();
    const first = await setRepoEnvVar("acme", "widgets", "API_URL", "https://api.example.com");
    expect(first).toMatchObject({ ok: true, action: "set", previously: "absent" });
    const second = await setRepoEnvVar("acme", "widgets", "API_URL", "https://prod.example.com");
    expect(second).toMatchObject({ ok: true, action: "set", previously: "set" });
    const env = await mergeContainerEnv(BASE, "acme/widgets");
    expect(env.API_URL).toBe("https://prod.example.com");
  });

  it("removes with a null value, and dropping the last key empties the repo entry", async () => {
    resetRuntimeEnvForTest();
    await setRepoEnvVar("acme", "widgets", "ONLY_KEY", "v");
    const removed = await setRepoEnvVar("acme", "widgets", "ONLY_KEY", null);
    expect(removed).toMatchObject({ ok: true, action: "removed" });
    expect(await repoEnvKeys("acme", "widgets")).toEqual([]);
  });

  it("refuses a malformed name instead of storing something unusable", async () => {
    resetRuntimeEnvForTest();
    const bad = await setRepoEnvVar("acme", "widgets", "1BAD NAME", "v");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("not a valid environment variable name");
  });
});

describe("setRepoEnvFromText — the pasted-env path", () => {
  it("stores every pair and keeps the file itself nowhere", async () => {
    resetRuntimeEnvForTest();
    const outcome = await setRepoEnvFromText("acme", "widgets", "VITE_SUPABASE_URL=https://x.supabase.co\nVITE_ANON=eyJhbGciOi");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.keys.sort()).toEqual(["VITE_ANON", "VITE_SUPABASE_URL"]);
    const env = await mergeContainerEnv(BASE, "acme/widgets");
    expect(env.VITE_SUPABASE_URL).toBe("https://x.supabase.co");
  });

  it("says so plainly when the paste holds no pairs", async () => {
    resetRuntimeEnvForTest();
    const outcome = await setRepoEnvFromText("acme", "widgets", "# just a comment\n\nand some prose");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("no `KEY=value` lines");
  });

  it("a later paste wins over an earlier value — corrections land", async () => {
    resetRuntimeEnvForTest();
    await setRepoEnvFromText("acme", "widgets", "API_URL=https://staging.example.com");
    await setRepoEnvFromText("acme", "widgets", "API_URL=https://prod.example.com");
    const env = await mergeContainerEnv(BASE, "acme/widgets");
    expect(env.API_URL).toBe("https://prod.example.com");
  });
});
