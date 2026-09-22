// ============================================================
// Preview Path Aliases — Regression Suite
// ============================================================
// These cases are the repository's OWN config files. The preview could
// not render this app before this module existed: `@/…` was classified as
// a package, externalized, and handed to a browser that cannot resolve it,
// which aborts the whole module graph and leaves a blank frame.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  normalizeTarget,
  parseTsconfigAliases,
  parseViteConfigAliases,
  readAliasConfig,
  resolveAlias,
  stripJsonc,
} from "./aliases";

/** Builds an `exists` predicate from a list of repo paths */
const existsIn = (paths: string[]) => (p: string) => new Set(paths).has(p);

describe("stripJsonc", () => {
  it("removes comments and trailing commas from a real tsconfig", () => {
    const raw = `{
      // the app config
      "compilerOptions": {
        "baseUrl": ".",
        /* block comment */
        "paths": { "@/*": ["./src/*"], },
      },
    }`;
    const parsed = JSON.parse(stripJsonc(raw)) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(parsed.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
  });

  it("does not cut a // that lives inside a string", () => {
    const raw = '{ "url": "https://example.com/x", "n": 1 }';
    expect(JSON.parse(stripJsonc(raw))).toEqual({
      url: "https://example.com/x",
      n: 1,
    });
  });
});

describe("normalizeTarget", () => {
  it("normalizes a tsconfig target into a directory prefix", () => {
    expect(normalizeTarget("./src/*")).toBe("src/");
    expect(normalizeTarget("src/*")).toBe("src/");
    expect(normalizeTarget("./src")).toBe("src");
    expect(normalizeTarget("/src/app")).toBe("src/app");
  });

  it("clamps a target that points outside the repository", () => {
    expect(normalizeTarget("../../shared/src/*")).toBe("shared/src/");
  });
});

describe("parseTsconfigAliases", () => {
  it("reads this repository's tsconfig paths and baseUrl", () => {
    // Verbatim from tsconfig.json in this project.
    const raw = `{
  "files": [],
  "references": [],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}`;
    const { baseUrl, paths } = parseTsconfigAliases(raw);
    expect(baseUrl).toBe(".");
    expect(paths["@/*"]).toEqual(["./src/*"]);
  });

  it("returns nothing for a missing or broken file", () => {
    expect(parseTsconfigAliases(null).paths).toEqual({});
    expect(parseTsconfigAliases("{oops").paths).toEqual({});
    expect(parseTsconfigAliases("{}").baseUrl).toBeNull();
  });

  it("drops a paths entry whose targets are not strings", () => {
    const raw = JSON.stringify({ compilerOptions: { paths: { good: ["a/*"], bad: [1, 2] } } });
    expect(Object.keys(parseTsconfigAliases(raw).paths)).toEqual(["good"]);
  });
});

describe("parseViteConfigAliases", () => {
  it("reads this repository's vite.config.ts alias", () => {
    // Verbatim shape from vite.config.ts in this project.
    const raw = `export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "es6-promise-pool": path.resolve(__dirname, "./src/lib/es6-promise-pool-esm.js"),
    },
  },
});`;
    const { alias, unparsed } = parseViteConfigAliases(raw);
    expect(unparsed).toBe(false);
    expect(alias["@"]).toBe("src");
    expect(alias["es6-promise-pool"]).toBe("src/lib/es6-promise-pool-esm.js");
  });

  it("reads a fileURLToPath alias and a bare relative string", () => {
    const raw = `export default {
      resolve: { alias: { "~": fileURLToPath(new URL("./app", import.meta.url)), "@ui": "./app/ui" } },
    };`;
    const { alias } = parseViteConfigAliases(raw);
    expect(alias["~"]).toBe("app");
    expect(alias["@ui"]).toBe("app/ui");
  });

  it("reads a vite root, which entry detection needs", () => {
    expect(parseViteConfigAliases(`export default { root: "src" };`).root).toBe("src");
  });

  it("says so when an alias cannot be read statically", () => {
    const raw = `export default { resolve: { alias: buildAliases() } };`;
    const result = parseViteConfigAliases(raw);
    expect(result.unparsed).toBe(true);
    expect(result.alias).toEqual({});
  });

  it("reports nothing for a config with no aliases at all", () => {
    const result = parseViteConfigAliases(`export default { plugins: [] };`);
    expect(result.unparsed).toBe(false);
    expect(result.alias).toEqual({});
  });

  it("handles a missing config", () => {
    expect(parseViteConfigAliases(null).alias).toEqual({});
    expect(parseViteConfigAliases("").unparsed).toBe(false);
  });
});

describe("readAliasConfig", () => {
  it("combines tsconfig and vite aliases, longest prefix first", () => {
    const config = readAliasConfig({
      configs: new Map([
        ["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } })],
        ["vite.config.ts", `export default { resolve: { alias: { "@": "./src" } } };`],
      ]),
    });
    expect(config.rules.length).toBeGreaterThanOrEqual(2);
    expect(config.rules[0]?.source).toBe("tsconfig");
    expect(config.rules[0]?.prefix).toBe("@/");
    expect(config.rules.find((r) => r.source === "vite")?.prefix).toBe("@");
  });

  it("flags a tsconfig that exists in the tree but could not be read", () => {
    const config = readAliasConfig({
      configs: new Map(),
      treePaths: ["tsconfig.base.json", "src/main.tsx"],
    });
    expect(config.unparsed).toBe(true);
    expect(config.read).toContain("tsconfig.base.json");
  });

  it("is empty and calm for a repository with no config files", () => {
    const config = readAliasConfig({ configs: new Map() });
    expect(config.rules).toEqual([]);
    expect(config.unparsed).toBe(false);
  });
});

describe("resolveAlias", () => {
  const config = readAliasConfig({
    configs: new Map([
      ["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } })],
      ["vite.config.ts", `export default { resolve: { alias: { "@": "./src" } } };`],
    ]),
  });

  const tree = [
    "src/lib/utils.ts",
    "src/components/ui/button.tsx",
    "src/index.css",
    "src/features/chat/index.ts",
    "src/stores/chat.store.ts",
  ];

  it("resolves an aliased module to its file, with extension candidates", () => {
    const exists = existsIn(tree);
    expect(resolveAlias("@/lib/utils", config, exists)).toBe("src/lib/utils.ts");
    expect(resolveAlias("@/components/ui/button", config, exists)).toBe("src/components/ui/button.tsx");
    expect(resolveAlias("@/index.css", config, exists)).toBe("src/index.css");
    expect(resolveAlias("@/features/chat", config, exists)).toBe("src/features/chat/index.ts");
  });

  it("resolves the exact alias form that a vite-only config defines", () => {
    const viteOnly = readAliasConfig({
      configs: new Map([["vite.config.ts", `export default { resolve: { alias: { "@": "./src" } } };`]]),
    });
    expect(resolveAlias("@/lib/utils", viteOnly, existsIn(tree))).toBe("src/lib/utils.ts");
  });

  it("leaves real packages alone, so package resolution still happens", () => {
    const exists = existsIn(tree);
    for (const spec of ["react", "zustand", "react-dom/client", "lodash/get"]) {
      expect(resolveAlias(spec, config, exists), spec).toBeNull();
    }
  });

  it("leaves a relative import alone", () => {
    expect(resolveAlias("./local", config, existsIn(tree))).toBeNull();
  });

  it("returns null for an aliased path that does not exist", () => {
    expect(resolveAlias("@/nope/missing", config, existsIn(tree))).toBeNull();
  });

  it("ignores query suffixes, which a Vite import may carry", () => {
    expect(resolveAlias("@/lib/utils?raw", config, existsIn(tree))).toBe("src/lib/utils.ts");
  });

  it("is a cheap no-op when the project declares no aliases", () => {
    const none = readAliasConfig({ configs: new Map() });
    expect(resolveAlias("@/lib/utils", none, existsIn(tree))).toBeNull();
  });
});
