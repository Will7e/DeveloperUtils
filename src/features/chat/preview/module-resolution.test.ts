// ============================================================
// Module Resolution — Import Map Regression Suite
// ============================================================
// The regression that matters here was not a crash: the preview shipped a
// hardcoded React-only import map, every other bare import was silently
// externalized, and the frame went black with no diagnostic because
// esbuild had succeeded. So the central test below is a whole-repository
// promise — EVERY bare specifier the workspace imports resolves to a
// destination — rather than a per-function assertion.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildPreviewImportMap,
  collectBareSpecifiers,
  collectDeclaredVersions,
  isBundlerInternal,
  isCoveredByImportMap,
  isNodeBuiltin,
  normalizeVersion,
  packageModuleUrl,
  parseLockfileVersions,
  parsePackageJson,
  pickLockfilePath,
  splitBareSpecifier,
} from "./module-resolution";

describe("splitBareSpecifier", () => {
  it("splits packages, subpaths and scoped names", () => {
    expect(splitBareSpecifier("react")).toEqual({ pkg: "react", subpath: "" });
    expect(splitBareSpecifier("react-dom/client")).toEqual({
      pkg: "react-dom",
      subpath: "client",
    });
    expect(splitBareSpecifier("@radix-ui/react-slot")).toEqual({
      pkg: "@radix-ui/react-slot",
      subpath: "",
    });
    expect(splitBareSpecifier("@scope/pkg/deep/thing.css")).toEqual({
      pkg: "@scope/pkg",
      subpath: "deep/thing.css",
    });
  });

  it("rejects specifiers the FS resolver owns", () => {
    for (const spec of ["./x", "../y", "/abs", "\\win", "https://x/y", "data:text/css,x"]) {
      expect(splitBareSpecifier(spec), spec).toBeNull();
    }
  });

  it("ignores query and hash suffixes", () => {
    expect(splitBareSpecifier("swiper/css?inline")).toEqual({ pkg: "swiper", subpath: "css" });
    expect(splitBareSpecifier("react#frag")).toEqual({ pkg: "react", subpath: "" });
  });

  it("does not treat a bare scope as a package", () => {
    expect(splitBareSpecifier("@scope")).toBeNull();
    expect(splitBareSpecifier("@scope/")).toBeNull();
  });
});

describe("node builtins and bundler internals", () => {
  it("recognizes builtins with and without the node: prefix", () => {
    expect(isNodeBuiltin("fs")).toBe(true);
    expect(isNodeBuiltin("node:fs")).toBe(true);
    expect(isNodeBuiltin("path/posix")).toBe(true);
    expect(isNodeBuiltin("path-browserify")).toBe(false);
    expect(isNodeBuiltin("fs-extra")).toBe(false);
  });

  it("recognizes specifiers only the bundler can answer", () => {
    for (const spec of ["virtual:foo", "@vite/client", "vite/modulepreload", "@id/x", "\0rollup"]) {
      expect(isBundlerInternal(spec), spec).toBe(true);
    }
    expect(isBundlerInternal("react")).toBe(false);
  });
});

describe("parsePackageJson", () => {
  it("reads name, dependencies, devDependencies and peerDependencies", () => {
    const manifest = parsePackageJson(
      JSON.stringify({
        name: "app",
        dependencies: { react: "^19.2.0" },
        devDependencies: { vite: "^7.0.0" },
        peerDependencies: { "react-dom": "^19.0.0" },
      })
    );
    expect(manifest.name).toBe("app");
    expect(manifest.dependencies.react).toBe("^19.2.0");
    expect(manifest.devDependencies.vite).toBe("^7.0.0");
    expect(manifest.peerDependencies["react-dom"]).toBe("^19.0.0");
  });

  it("degrades to empty instead of throwing on junk", () => {
    for (const raw of [null, undefined, "", "not json", "[]", '"str"']) {
      const manifest = parsePackageJson(raw);
      expect(manifest.dependencies).toEqual({});
      expect(manifest.name).toBeNull();
    }
  });

  it("drops non-string version values", () => {
    const manifest = parsePackageJson(
      JSON.stringify({ dependencies: { ok: "1.0.0", bad: { nested: true }, alsoBad: 3 } })
    );
    expect(manifest.dependencies).toEqual({ ok: "1.0.0" });
  });
});

describe("parseLockfileVersions", () => {
  it("reads exact versions from a v3 lockfile, including scoped packages", () => {
    const versions = parseLockfileVersions(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          "node_modules/react": { version: "19.2.5" },
          "node_modules/@radix-ui/react-slot": { version: "1.2.4" },
          "node_modules/a/node_modules/b": { version: "2.0.0" },
        },
      })
    );
    expect(versions.react).toBe("19.2.5");
    expect(versions["@radix-ui/react-slot"]).toBe("1.2.4");
    expect(versions.b).toBe("2.0.0");
  });

  it("reads a v1 lockfile", () => {
    const versions = parseLockfileVersions(
      JSON.stringify({ dependencies: { react: { version: "18.3.1" } } })
    );
    expect(versions.react).toBe("18.3.1");
  });

  it("returns nothing for junk rather than guessing", () => {
    expect(parseLockfileVersions("{oops")).toEqual({});
    expect(parseLockfileVersions(null)).toEqual({});
  });

  it("prefers an npm lockfile and declines to half-parse others", () => {
    expect(pickLockfilePath(["pnpm-lock.yaml", "package-lock.json"])).toBe("package-lock.json");
    expect(pickLockfilePath(["pnpm-lock.yaml"])).toBeNull();
  });
});

describe("normalizeVersion", () => {
  it("turns ranges into concrete versions", () => {
    expect(normalizeVersion("^19.2.0")).toBe("19.2.0");
    expect(normalizeVersion("~1.2.3")).toBe("1.2.3");
    expect(normalizeVersion(">=1.2.3 <2.0.0")).toBe("1.2.3");
    expect(normalizeVersion("^1.2.3 || ^2.0.0")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(normalizeVersion("npm:other-pkg@^2.1.0")).toBe("2.1.0");
  });

  it("refuses specifiers that name no published version", () => {
    for (const range of ["workspace:*", "file:../local", "link:../x", "git+https://x/y", "*", "latest", ""]) {
      expect(normalizeVersion(range), range).toBeNull();
    }
    expect(normalizeVersion(undefined)).toBeNull();
  });
});

describe("collectDeclaredVersions", () => {
  it("prefers a lockfile pin over the declared range", () => {
    const manifest = parsePackageJson(
      JSON.stringify({ dependencies: { react: "^19.0.0" } })
    );
    expect(collectDeclaredVersions(manifest, { react: "19.2.5" }).react).toBe("19.2.5");
    expect(collectDeclaredVersions(manifest, {}).react).toBe("^19.0.0");
  });
});

describe("packageModuleUrl", () => {
  it("pins the version and shares the React instance", () => {
    expect(packageModuleUrl("react", "19.2.0")).toBe("https://esm.sh/react@19.2.0");
    expect(packageModuleUrl("react-dom", "19.2.0")).toBe(
      "https://esm.sh/react-dom@19.2.0?external=react"
    );
  });

  it("omits the version when there is none", () => {
    expect(packageModuleUrl("left-pad", null)).toBe("https://esm.sh/left-pad");
  });
});

describe("isCoveredByImportMap", () => {
  const imports = { react: "u", "react/": "u/", "@radix-ui/react-slot": "u2" };

  it("matches exactly, by prefix, and by the LONGEST prefix", () => {
    expect(isCoveredByImportMap("react", imports)).toBe(true);
    expect(isCoveredByImportMap("react/jsx-runtime", imports)).toBe(true);
    expect(isCoveredByImportMap("react-dom/client", imports)).toBe(false);
    expect(isCoveredByImportMap("@radix-ui/react-slot", imports)).toBe(true);
    // A scoped name must not be satisfied by a shorter unrelated prefix.
    expect(isCoveredByImportMap("@radix-ui/react-slot/foo", imports)).toBe(false);
  });

  it("ignores query strings, which must not defeat a match", () => {
    expect(isCoveredByImportMap("react?raw", imports)).toBe(true);
  });

  it("does not match inherited prototype keys", () => {
    expect(isCoveredByImportMap("toString", imports)).toBe(false);
    expect(isCoveredByImportMap("constructor", imports)).toBe(false);
  });
});

describe("collectBareSpecifiers", () => {
  it("collects bare imports from JS/TS files and skips other file types", () => {
    const found = collectBareSpecifiers([
      { path: "src/a.ts", content: 'import { create } from "zustand";\nimport "./local";' },
      { path: "src/b.tsx", content: 'export { x } from "lodash/get";' },
      { path: "src/c.css", content: '@import "swiper/css";' },
      { path: "README.md", content: 'import "not-code";' },
    ]);
    expect(found.sort()).toEqual(["lodash/get", "zustand"]);
  });

  it("catches the forms that silently break a bundle", () => {
    const found = collectBareSpecifiers([
      {
        path: "src/main.ts",
        content: [
          'const a = await import("axios");',
          'const b = require("chalk");',
          'export * from "date-fns";',
          'import "normalize.css";',
        ].join("\n"),
      },
    ]);
    expect(found.sort()).toEqual(["axios", "chalk", "date-fns", "normalize.css"]);
  });
});

// ── The regression net ───────────────────────────────────────

describe("buildPreviewImportMap — every external import has a destination", () => {
  /** A realistic Vite + React + Tailwind repository */
  const repo = {
    "package.json": JSON.stringify({
      name: "fixture-app",
      dependencies: {
        react: "^19.2.0",
        "react-dom": "^19.2.0",
        zustand: "^5.0.12",
        "lucide-react": "^1.11.0",
        "react-router-dom": "^7.14.2",
        "@radix-ui/react-slot": "^1.2.4",
        swiper: "^11.0.0",
      },
      devDependencies: { tailwindcss: "^4.2.4", vite: "^7.0.0", typescript: "^5.9.0" },
    }),
    "src/main.tsx": [
      'import React from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { create } from "zustand";',
      'import { Home } from "lucide-react";',
      'import { BrowserRouter } from "react-router-dom";',
      'import { Slot } from "@radix-ui/react-slot";',
      'import "swiper/css";',
      'import "./index.css";',
    ].join("\n"),
    "src/index.css": '@import "tailwindcss";\n@import "./tokens.css";\n',
  };

  it("maps every bare specifier the repository imports", () => {
    const manifest = parsePackageJson(repo["package.json"]);
    const specifiers = collectBareSpecifiers(
      Object.entries(repo).map(([path, content]) => ({ path, content }))
    );
    const map = buildPreviewImportMap({ manifest, specifiers });

    expect(specifiers.length).toBeGreaterThan(5);
    for (const specifier of specifiers) {
      expect(
        isCoveredByImportMap(specifier, map.imports),
        `unmapped specifier: ${specifier}`
      ).toBe(true);
    }
    expect(map.unmapped).toEqual([]);
  });

  it("uses the lockfile's exact version when one is present", () => {
    const manifest = parsePackageJson(repo["package.json"]);
    const map = buildPreviewImportMap({
      manifest,
      lockfileVersions: { react: "19.2.5", zustand: "5.0.13" },
    });
    expect(map.imports.react).toBe("https://esm.sh/react@19.2.5");
    expect(map.imports.zustand).toBe("https://esm.sh/zustand@5.0.13");
  });

  it("does not leave the React instance duplicated", () => {
    const map = buildPreviewImportMap({ manifest: parsePackageJson(repo["package.json"]) });
    expect(map.imports["react-dom"]).toContain("external=react");
    expect(map.imports["react"]).not.toContain("external=");
  });

  it("covers subpath imports through the trailing-slash entry", () => {
    const map = buildPreviewImportMap({ manifest: parsePackageJson(repo["package.json"]) });
    expect(isCoveredByImportMap("swiper/css", map.imports)).toBe(true);
    expect(isCoveredByImportMap("react-dom/client", map.imports)).toBe(true);
    expect(isCoveredByImportMap("react/jsx-runtime", map.imports)).toBe(true);
  });

  it("names WHY an import is unmapped instead of failing silently", () => {
    const manifest = parsePackageJson(repo["package.json"]);
    const map = buildPreviewImportMap({
      manifest,
      specifiers: ["fs", "some-unlisted-pkg", "@vite/client", "workspace-pkg"],
    });
    const byName = new Map(map.unmapped.map((u) => [u.specifier, u.reason]));
    expect(byName.get("fs")).toContain("Node.js built-in");
    expect(byName.get("some-unlisted-pkg")).toContain("not in this repository's package.json");
    // Bundler internals are never the user's problem, so they are not noise.
    expect(byName.has("@vite/client")).toBe(false);
    expect(byName.get("workspace-pkg")).toContain("not in this repository's package.json");
  });

  it("reports a declared-but-unpublishable dependency as its own reason", () => {
    const manifest = parsePackageJson(
      JSON.stringify({ dependencies: { "local-pkg": "workspace:*" } })
    );
    const map = buildPreviewImportMap({ manifest, specifiers: ["local-pkg"] });
    expect(map.known.has("local-pkg")).toBe(true);
    expect(map.unmapped[0]?.reason).toContain("no publishable version");
  });

  it("is empty but valid for a repository with no dependencies", () => {
    const map = buildPreviewImportMap({ manifest: parsePackageJson("{}") });
    expect(map.imports).toEqual({});
    expect(map.unmapped).toEqual([]);
  });
});
