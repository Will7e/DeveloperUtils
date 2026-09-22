// ============================================================
// Preview Glob — Regression Suite
// ============================================================
// The failure this exists for, from a real console:
//
//   Uncaught TypeError: (intermediate value).glob is not a function
//
// `import.meta.glob` is a Vite api rewritten at build time. Left in a bundle
// it throws while the entry module initialises, so the app never renders and
// the pane shows the same black rectangle as a broken document — with an
// error that names neither the file nor the API.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  findGlobCalls,
  globToRegExp,
  matchGlob,
  selectGlobPaths,
  transformImportMetaGlob,
} from "./glob";

const PAGES = ["src/pages/Home.jsx", "src/pages/About.jsx", "src/pages/nested/Deep.jsx"];

function transform(code: string, importer = "src/App.jsx", paths: string[] = PAGES) {
  return transformImportMetaGlob({
    code,
    importer,
    paths,
    read: (path) => (path.endsWith(".md") ? `text of ${path}` : null),
  });
}

describe("glob patterns", () => {
  it("treats `*` as one segment and `**` as any depth", () => {
    expect(matchGlob("src/pages/*.jsx", "src/pages/Home.jsx")).toBe(true);
    expect(matchGlob("src/pages/*.jsx", "src/pages/nested/Deep.jsx")).toBe(false);
    expect(matchGlob("src/pages/**/*.jsx", "src/pages/nested/Deep.jsx")).toBe(true);
    // `**/` must also match ZERO directories, which is the most common shape.
    expect(matchGlob("src/pages/**/*.jsx", "src/pages/Home.jsx")).toBe(true);
    expect(matchGlob("**/*.jsx", "src/pages/Home.jsx")).toBe(true);
  });

  it("supports alternation, single characters and classes", () => {
    expect(matchGlob("src/pages/*.{jsx,tsx}", "src/pages/Home.jsx")).toBe(true);
    expect(matchGlob("src/pages/*.{jsx,tsx}", "src/pages/Home.tsx")).toBe(true);
    expect(matchGlob("src/pages/Hom?.jsx", "src/pages/Home.jsx")).toBe(true);
    expect(matchGlob("src/pages/Hom[e].jsx", "src/pages/Home.jsx")).toBe(true);
    expect(matchGlob("src/pages/Hom[!e].jsx", "src/pages/Home.jsx")).toBe(false);
    // A dot is literal, not "any character".
    expect(matchGlob("src/pages/Home.jsx", "src/pages/HomeXjsx")).toBe(false);
    expect(globToRegExp("a/b.js").test("a/b.js")).toBe(true);
  });

  it("selects from the tree, relative to the importing file, minus negations", () => {
    const { matches, invalid } = selectGlobPaths(
      ["./pages/**/*.jsx", "!./pages/nested/**"],
      "src/App.jsx",
      PAGES
    );
    expect(matches).toEqual(["src/pages/About.jsx", "src/pages/Home.jsx"]);
    expect(invalid).toEqual([]);

    // A bare pattern is ambiguous in Vite, so it is reported rather than
    // guessed at.
    expect(selectGlobPaths(["**/*.jsx"], "src/App.jsx", PAGES).invalid).toEqual(["**/*.jsx"]);
    // Rooted patterns address the repository root regardless of the importer.
    expect(selectGlobPaths(["/src/pages/*.jsx"], "src/deep/App.jsx", PAGES).matches).toEqual([
      "src/pages/About.jsx",
      "src/pages/Home.jsx",
    ]);
  });
});

describe("finding the calls", () => {
  it("ignores strings and comments", () => {
    expect(findGlobCalls('const s = "import.meta.glob(./x)"; // import.meta.glob(./y)')).toEqual([]);
    expect(findGlobCalls("/* import.meta.glob('./x') */")).toEqual([]);
    expect(findGlobCalls("myimport.meta.glob('./x')")).toEqual([]);
  });

  it("reads nested arguments, arrays and the legacy spelling", () => {
    const [nested] = findGlobCalls(`import.meta.glob(patternFor("a(,)b"), { eager: true })`);
    expect(nested!.args).toContain('patternFor("a(,)b")');
    const [legacy] = findGlobCalls(`import.meta.globEager("./x/*.js")`);
    expect(legacy!.legacyEager).toBe(true);
    const [array] = findGlobCalls(`import.meta.glob(["./a/*.js", "./b/*.js"])`);
    expect(array!.args).toBe('(["./a/*.js", "./b/*.js"]'.slice(1));
  });
});

describe("rewriting import.meta.glob", () => {
  it("produces a lazy map keyed the way the app looks modules up", () => {
    const { code, rewritten, unsupported } = transform(
      `const pages = import.meta.glob("./pages/*.jsx");`
    );
    expect(unsupported).toEqual([]);
    expect(rewritten).toEqual(["./pages/*.jsx"]);
    expect(code).toContain('"./pages/About.jsx": () => import("./pages/About.jsx")');
    expect(code).toContain('"./pages/Home.jsx": () => import("./pages/Home.jsx")');
    expect(code).not.toContain("import.meta.glob");
  });

  it("produces static imports for an eager map", () => {
    const { code } = transform(`const pages = import.meta.glob("./pages/*.jsx", { eager: true });`);
    // The imports are real, and go above the module body: the values are the
    // modules themselves, not promises.
    expect(code).toMatch(/^import \* as __intab_glob_0 from "\.\/pages\/About\.jsx";/m);
    expect(code).toContain('"./pages/About.jsx": __intab_glob_0');
    expect(code).toContain('"./pages/Home.jsx": __intab_glob_1');
    expect(code).not.toContain("=>({");
  });

  it("inlines file text for an eager raw glob", () => {
    const { code } = transform(
      `const notes = import.meta.glob("./notes/*.md", { eager: true, as: "raw" });`,
      "src/App.jsx",
      ["src/notes/a.md"]
    );
    expect(code).toContain('"./notes/a.md": "text of src/notes/a.md"');
  });

  it("honours `import: \"default\"`, keys from a nested importer, and no matches", () => {
    expect(transform(`import.meta.glob("./pages/*.jsx", { import: "default" })`).code).toContain(
      '() => import("./pages/About.jsx").then((m) => m["default"])'
    );

    // Keys are relative to the file doing the globbing, so an app nested
    // deeper still finds what it asks for.
    const nested = transform(`import.meta.glob("../pages/*.jsx")`, "src/app/App.jsx", PAGES);
    expect(nested.code).toContain('"../pages/Home.jsx": () => import("../pages/Home.jsx")');

    // An unmatched pattern is an empty object in Vite, not a build failure.
    expect(transform(`import.meta.glob("./nothing/*.jsx")`).code).toContain("({})");
  });

  it("leaves what it cannot rewrite and says why", () => {
    const dynamic = transform("import.meta.glob(`./pages/${name}.jsx`);");
    expect(dynamic.code).toContain("import.meta.glob(");
    expect(dynamic.unsupported[0]!.reason).toContain("computed");

    const queried = transform(`import.meta.glob("./pages/*.jsx", { query: "?raw" });`);
    expect(queried.code).toContain("import.meta.glob(");
    expect(queried.unsupported[0]!.reason).toContain("query");

    const asUrl = transform(`import.meta.glob("./pages/*.jsx", { as: "url" });`);
    expect(asUrl.unsupported[0]!.reason).toContain("url");
  });

  it("returns untouched source byte-for-byte when there is no glob", () => {
    const plain = `const a = 1;\nif (a) { console.log("import.meta.glob is not called"); }\n`;
    const result = transform(plain);
    expect(result.code).toBe(plain);
    expect(result.rewritten).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });
});
