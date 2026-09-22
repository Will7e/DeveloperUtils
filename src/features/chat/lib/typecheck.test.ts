// ============================================================
// In-Browser Type Checking — Regression Suite
// ============================================================
// Two promises are load-bearing:
//
//   1. a diagnostic that is an artifact of this environment (no
//      node_modules, no lib files) is SUPPRESSED AND EXPLAINED, never
//      reported as a mistake in the user's code;
//   2. a check that did not run never reads as a pass.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildModuleShims,
  buildTypecheckPlan,
  classifyDiagnostics,
  formatDiagnostic,
  formatTypecheckReport,
  parseTsconfig,
  readTypescriptVersion,
  stripJsonc,
  TYPECHECK_MAX_FILES,
  TYPECHECK_MAX_REPORTED,
  type RawDiagnostic,
  type TypecheckFile,
} from "./typecheck";
import { toVirtualCompilerOptions } from "./typecheck-client";

const file = (path: string, content = ""): TypecheckFile => ({ path, content });

const diagnostic = (over: Partial<RawDiagnostic> = {}): RawDiagnostic => ({
  file: "src/a.ts",
  line: 1,
  code: 2322,
  message: "Type 'number' is not assignable to type 'string'.",
  category: 1,
  ...over,
});

describe("stripJsonc / parseTsconfig", () => {
  it("reads a tsconfig with comments and trailing commas", () => {
    const raw = `{
      // the app config
      "compilerOptions": {
        "strict": true, /* keep this on */
        "jsx": "react-jsx",
      },
    }`;
    const options = parseTsconfig(raw);
    expect(options.strict).toBe(true);
    expect(options.jsx).toBe("react-jsx");
  });

  it("degrades to no options rather than throwing", () => {
    expect(parseTsconfig("{oops")).toEqual({});
    expect(parseTsconfig(null)).toEqual({});
    expect(parseTsconfig("{}")).toEqual({});
  });

  it("does not cut a comment marker inside a string", () => {
    expect(stripJsonc('{ "u": "https://x/y" }')).toContain("https://x/y");
  });
});

describe("readTypescriptVersion", () => {
  it("reads the repository's pinned version", () => {
    const version = readTypescriptVersion([
      file("package.json", JSON.stringify({ devDependencies: { typescript: "^5.9.3" } })),
    ]);
    expect(version).toBe("5.9.3");
  });

  it("returns null when there is no pin to read", () => {
    expect(readTypescriptVersion([file("package.json", "{}")])).toBeNull();
    expect(readTypescriptVersion([])).toBeNull();
    expect(readTypescriptVersion([file("package.json", "{oops")])).toBeNull();
  });
});

describe("buildTypecheckPlan", () => {
  it("compiles the repository's sources and ignores build output", () => {
    const plan = buildTypecheckPlan({
      files: [
        file("src/a.ts"),
        file("src/b.tsx"),
        file("src/types.d.ts"),
        file("node_modules/pkg/index.d.ts"),
        file("dist/bundle.js"),
        file("README.md"),
      ],
    });
    expect(plan.rootNames).toEqual(["src/a.ts", "src/b.tsx", "src/types.d.ts"]);
    expect(plan.empty).toBe(false);
  });

  it("forces the options that make this a check rather than a build", () => {
    const plan = buildTypecheckPlan({ files: [file("src/a.ts")] });
    expect(plan.compilerOptions.noEmit).toBe(true);
    expect(plan.compilerOptions.skipLibCheck).toBe(true);
    expect(plan.compilerOptions.types).toEqual([]);
  });

  it("inherits the repository's own strictness and jsx settings", () => {
    const plan = buildTypecheckPlan({
      files: [file("src/a.ts")],
      tsconfigRaw: JSON.stringify({
        compilerOptions: { strict: true, jsx: "react-jsx", target: "ES2022", paths: { "@/*": ["./src/*"] } },
      }),
    });
    expect(plan.compilerOptions.strict).toBe(true);
    expect(plan.compilerOptions.jsx).toBe("react-jsx");
    expect(plan.compilerOptions.target).toBe("ES2022");
    expect(plan.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
  });

  it("caps a monorepo-sized workspace and SAYS SO", () => {
    const files = Array.from({ length: TYPECHECK_MAX_FILES + 25 }, (_, i) => file(`src/f${i}.ts`));
    const plan = buildTypecheckPlan({ files });
    expect(plan.rootNames).toHaveLength(TYPECHECK_MAX_FILES);
    expect(plan.limits.join(" ")).toContain("only the first");
  });

  it("always states that dependency types are erased", () => {
    const plan = buildTypecheckPlan({ files: [file("src/a.ts")] });
    expect(plan.limits.join(" ")).toContain("erased to `any`");
  });

  it("reports a tsconfig that asks for type packages it cannot have", () => {
    const plan = buildTypecheckPlan({
      files: [file("src/a.ts")],
      tsconfigRaw: JSON.stringify({ compilerOptions: { types: ["node", "vite/client"] } }),
    });
    expect(plan.limits.join(" ")).toContain("node, vite/client");
  });

  it("is empty — not silently clean — when there is nothing to check", () => {
    const plan = buildTypecheckPlan({ files: [file("README.md")] });
    expect(plan.empty).toBe(true);
    expect(plan.rootNames).toEqual([]);
  });

  it("falls back to a known TypeScript version when none is pinned", () => {
    expect(buildTypecheckPlan({ files: [file("src/a.ts")] }).typescriptVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("buildModuleShims", () => {
  const shims = buildModuleShims([
    file(
      "src/main.tsx",
      [
        'import { create } from "zustand";',
        'import { x } from "@radix-ui/react-slot";',
        'import "swiper/css";',
        'import "./local";',
        'import { readFile } from "fs";',
      ].join("\n")
    ),
  ]);

  it("erases every bare package the workspace imports", () => {
    expect(shims).toContain('declare module "zustand";');
    expect(shims).toContain('declare module "@radix-ui/react-slot";');
    expect(shims).toContain('declare module "swiper/css";');
  });

  it("does NOT erase relative imports, which are the code worth checking", () => {
    expect(shims).not.toContain('declare module "./local"');
  });

  it("does not declare a Node builtin the browser cannot have anyway", () => {
    expect(shims).not.toContain('declare module "fs"');
  });

  it("always provides a JSX namespace, since react's types are erased", () => {
    expect(shims).toContain("declare namespace JSX");
    expect(shims).toContain("IntrinsicElements");
  });
});

describe("classifyDiagnostics", () => {
  it("keeps errors and drops warnings outside the change set", () => {
    const result = classifyDiagnostics([
      diagnostic({ code: 2322 }),
      diagnostic({ code: 6133, category: 0, file: "src/other.ts" }),
    ]);
    expect(result.reported).toHaveLength(1);
    expect(result.reported[0]?.code).toBe(2322);
  });

  it("keeps a warning IN the change set, because it is about the agent's work", () => {
    const result = classifyDiagnostics([diagnostic({ code: 6133, category: 0 })], {
      changedPaths: ["src/a.ts"],
    });
    expect(result.reported).toHaveLength(1);
  });

  it("suppresses environment artifacts and explains them", () => {
    const result = classifyDiagnostics([
      diagnostic({ code: 2307, message: "Cannot find module 'react'." }),
      diagnostic({ code: 2688, message: "Cannot find type definition file for 'node'." }),
    ]);
    expect(result.reported).toHaveLength(0);
    expect(result.suppressed).toBe(2);
    expect(result.suppressionReasons.join(" ")).toContain("not installed");
  });

  it("ranks the agent's changed files first", () => {
    const result = classifyDiagnostics(
      [
        diagnostic({ file: "src/zzz.ts", line: 5 }),
        diagnostic({ file: "src/aaa.ts", line: 9 }),
        diagnostic({ file: "src/mine.ts", line: 3 }),
      ],
      { changedPaths: ["src/mine.ts"] }
    );
    expect(result.reported[0]?.file).toBe("src/mine.ts");
    expect(result.reported.slice(1).map((d) => d.file)).toEqual(["src/aaa.ts", "src/zzz.ts"]);
  });

  it("dedupes identical diagnostics", () => {
    const result = classifyDiagnostics([diagnostic(), diagnostic(), diagnostic()]);
    expect(result.reported).toHaveLength(1);
  });

  it("caps the report and counts the remainder", () => {
    const many = Array.from({ length: TYPECHECK_MAX_REPORTED + 7 }, (_, i) =>
      diagnostic({ line: i + 1, message: `error ${i}` })
    );
    const result = classifyDiagnostics(many);
    expect(result.reported).toHaveLength(TYPECHECK_MAX_REPORTED);
    expect(result.omitted).toBe(7);
  });

  it("handles an empty list", () => {
    expect(classifyDiagnostics([]).reported).toEqual([]);
  });
});

describe("formatTypecheckReport", () => {
  const plan = buildTypecheckPlan({ files: [file("src/a.ts")] });

  it("says clean without overclaiming", () => {
    const report = formatTypecheckReport({
      plan,
      classification: { reported: [], omitted: 0, suppressed: 0, suppressionReasons: [] },
      checkedFiles: 1,
    });
    expect(report).toContain("TYPECHECK: clean");
    expect(report).toContain("not a test run");
  });

  it("counts errors and formats each with file, line and code", () => {
    const report = formatTypecheckReport({
      plan,
      classification: {
        reported: [diagnostic({ file: "src/a.ts", line: 12, code: 2322 })],
        omitted: 0,
        suppressed: 0,
        suppressionReasons: [],
      },
      checkedFiles: 3,
      durationMs: 420,
    });
    expect(report).toContain("TYPECHECK: 1 error(s)");
    expect(report).toContain("src/a.ts:12 — TS2322");
    expect(report).toContain("420ms");
  });

  it("states what it ignored and what it could not check", () => {
    const report = formatTypecheckReport({
      plan,
      classification: {
        reported: [],
        omitted: 0,
        suppressed: 4,
        suppressionReasons: ["Cannot find module — the package is not installed in the browser"],
      },
      checkedFiles: 2,
    });
    expect(report).toContain("Ignored 4");
    expect(report).toContain("Limits of this check");
  });

  it("NEVER reports an unavailable check as a pass", () => {
    const report = formatTypecheckReport({
      plan,
      classification: { reported: [], omitted: 0, suppressed: 0, suppressionReasons: [] },
      checkedFiles: 0,
      unavailableReason: "the compiler could not be loaded",
    });
    expect(report).toContain("TYPECHECK: unavailable");
    expect(report).toContain("NOT a pass");
    expect(report).not.toContain("TYPECHECK: clean");
  });

  it("formats a single diagnostic readably", () => {
    expect(formatDiagnostic(diagnostic({ file: "src/a.ts", line: 3 }))).toBe(
      "src/a.ts:3 — TS2322 error: Type 'number' is not assignable to type 'string'."
    );
    expect(formatDiagnostic(diagnostic({ file: null, line: null }))).toContain("tsconfig");
  });
});

describe("toVirtualCompilerOptions", () => {
  it("roots baseUrl at the virtual file system", () => {
    expect(toVirtualCompilerOptions({ baseUrl: "." }).baseUrl).toBe("/");
    expect(toVirtualCompilerOptions({ baseUrl: "src" }).baseUrl).toBe("/src");
    expect(toVirtualCompilerOptions({}).baseUrl).toBe("/");
  });

  it("roots every alias target so @/* resolves inside the worker", () => {
    const options = toVirtualCompilerOptions({
      baseUrl: ".",
      paths: { "@/*": ["./src/*"], "@ui": ["./src/ui"] },
    });
    expect(options.paths).toEqual({ "@/*": ["/src/*"], "@ui": ["/src/ui"] });
  });

  it("does not invent a star the repository did not write", () => {
    const options = toVirtualCompilerOptions({ paths: { exact: ["./src/exact.ts"] } });
    expect((options.paths as Record<string, string[]>).exact).toEqual(["/src/exact.ts"]);
  });

  it("leaves unrelated options alone", () => {
    expect(toVirtualCompilerOptions({ strict: true }).strict).toBe(true);
  });
});
