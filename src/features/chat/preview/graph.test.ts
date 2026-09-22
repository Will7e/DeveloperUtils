// ============================================================
// Preview Graph — A Real Bundle, From a Fake Module Host
// ============================================================
// Every failure this rewrite exists to remove was invisible until a browser
// tried the bundle: a second React arriving inside a package, a bare import
// left for a runtime resolver to reject, an image handed to the JS parser.
// None of them could be seen from the workspace, and none of them produced
// a build diagnostic.
//
// So these tests do not assert that a function returned the right string.
// They run esbuild-wasm for real, over a workspace and a fake module host,
// and make statements about the OUTPUT: no imports left in it, exactly one
// React instance inside it, an asset's bytes inlined as a data URL, and an
// unresolvable import FAILING THE BUILD rather than reaching the frame.
//
// The fake host also models the part of esm.sh that broke the previous
// design: a package URL REDIRECTS to its built path, and the source's own
// relative imports are only meaningful against the redirected URL.

import { beforeAll, describe, expect, it } from "vitest";
import * as esbuild from "esbuild-wasm";
import { bundleWorkspace } from "./bundle";
import { createGraphReport, planRequest, WORKSPACE_NS, REMOTE_NS } from "./graph";
import { readAliasConfig } from "./aliases";
import { resolveEntryScriptPath } from "./entry";
import { createWorkspaceVfs } from "./vfs";
import { planCss, detectCssToolchain } from "./css-pipeline";
import { parsePackageJson } from "./module-resolution";
import type { WorkspaceState } from "../types";

beforeAll(async () => {
  // The browser init needs a wasm URL and a worker; Node needs neither.
  await esbuild.initialize({ worker: false });
});

// ── The fake module host ─────────────────────────────────────

/** What esm.sh answers `react@19.3.0` with, after its redirect */
const REACT_BUILD_URL = "https://esm.sh/v135/react@19.3.0/es2022/react.mjs";
const REACT_CHUNK_URL = "https://esm.sh/v135/react@19.3.0/es2022/react.chunk.mjs";

const REQUESTED = {
  react: "https://esm.sh/react@19.3.0",
  jsxRuntime: "https://esm.sh/react@19.3.0/jsx-runtime",
  reactDomClient: "https://esm.sh/react-dom@19.3.0/client?external=react",
  lucide: "https://esm.sh/lucide-react@1.11.0?external=react,react-dom",
};

interface HostEntry {
  /** Where the request lands after redirects — the module's identity */
  finalUrl: string;
  source: string;
}

/**
 * A host that serves the shapes esm.sh actually serves: a redirect on the
 * package URL, an internal build path referenced RELATIVELY from the
 * redirected module, and dependencies left as bare imports because of
 * `external=`.
 */
const HOST: Record<string, HostEntry> = {
  [REQUESTED.react]: {
    finalUrl: REACT_BUILD_URL,
    source: `
      import { INTERNALS } from "./react.chunk.mjs";
      export const REACT_MARKER = "the-one-react";
      export function useRef(init) { return { current: init ?? null }; }
      export function useState(init) { return [init, () => {}, INTERNALS]; }
      export function createElement() { return null; }
    `,
  },
  [REACT_CHUNK_URL]: {
    finalUrl: REACT_CHUNK_URL,
    source: `export const INTERNALS = "shared-internals";`,
  },
  [REQUESTED.jsxRuntime]: {
    finalUrl: REQUESTED.jsxRuntime,
    source: `
      import { REACT_MARKER } from "react";
      export function jsx(type) { return { type, marker: REACT_MARKER }; }
      export const jsxs = jsx;
      export const Fragment = "fragment";
    `,
  },
  [REQUESTED.reactDomClient]: {
    finalUrl: REQUESTED.reactDomClient,
    source: `
      import { REACT_MARKER } from "react";
      export function createRoot() { return { render() {}, instance: REACT_MARKER }; }
    `,
  },
  // esm.sh leaves react to us here — that is what `?external=` means — so
  // this module's React and the entry's MUST become one module object.
  [REQUESTED.lucide]: {
    finalUrl: REQUESTED.lucide,
    source: `
      import { useRef } from "react";
      export function Home() { return typeof useRef === "function"; }
    `,
  },
};

function fakeHost() {
  const log: string[] = [];
  return {
    log,
    fetchModule: async (url: string) => {
      log.push(url);
      const entry = HOST[url];
      if (!entry) throw new Error(`404 ${url}`);
      return entry;
    },
  };
}

// ── The workspace ────────────────────────────────────────────

const WEBP_BASE64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEALmk0mkQAA3AAAA==";

function workspace(files: Record<string, string>): WorkspaceState {
  return {
    conversationId: "c1",
    owner: "o",
    repo: "r",
    branch: "main",
    baseCommitSha: "sha",
    workingBranch: null,
    tree: Object.keys(files).map((path) => ({ path, type: "blob" as const })),
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          path,
          content,
          baseContent: content,
          baseSha: "sha",
          status: "unchanged" as const,
          updatedAt: 0,
        },
      ])
    ),
    updatedAt: 0,
  };
}

const MANIFEST = JSON.stringify({
  dependencies: {
    react: "19.3.0",
    "react-dom": "19.3.0",
    "lucide-react": "11.0.0",
    // Declared, but deliberately absent from the fake host: the "package
    // exists, the host does not serve it" case.
    zustand: "5.0.12",
  },
  devDependencies: { tailwindcss: "^4.2.4" },
});

/** pkg → version, standing in for the runtime's derivation from package.json */
function versionsFor(): Record<string, string | null> {
  const parsed = parsePackageJson(MANIFEST);
  const out: Record<string, string | null> = {};
  for (const [pkg, range] of Object.entries({
    ...parsed.dependencies,
    ...parsed.devDependencies,
  })) {
    out[pkg] = /lucide/.test(pkg) ? "1.11.0" : range.replace(/^[\^~]/, "");
  }
  return out;
}

function cssPlanFor(ws: WorkspaceState) {
  return planCss(
    detectCssToolchain({
      manifest: parsePackageJson(MANIFEST),
      cssFiles: Object.entries(ws.files).map(([path, f]) => ({ path, content: f.content })),
    })
  );
}

async function bundle(files: Record<string, string>, asset = true, entry = "src/main.tsx") {
  const ws = workspace(files);
  const host = fakeHost();
  const output = await bundleWorkspace({
    entry,
    vfs: createWorkspaceVfs(ws),
    aliases: readAliasConfig({ configs: new Map(), treePaths: [] }),
    versions: versionsFor(),
    define: {
      "import.meta.env": JSON.stringify({ MODE: "production", PROD: true, DEV: false }),
      "import.meta.hot": "undefined",
    },
    cssPlan: cssPlanFor(ws),
    ports: {
      fetchModule: host.fetchModule,
      assetBase64: async (path) => (asset && path.endsWith(".webp") ? WEBP_BASE64 : null),
    },
  });
  return { output, host };
}

const APP = {
  "src/main.tsx": `
    import { useState, useRef } from "react";
    import { createRoot } from "react-dom/client";
    import { Home } from "lucide-react";
    import "./styles.css";
    import logo from "./logo.webp";
    const [count] = useState(0);
    const ref = useRef(null);
    const el = <div data-logo={logo} data-home={Home} data-count={count} data-ref={ref} />;
    createRoot(document.body).render(el);
  `,
  "src/styles.css": `
    @import "tailwindcss";
    @import "./theme.css";
    .logo { background-image: url("./logo.webp"); }
  `,
  "src/theme.css": `:root { --brand: red; }`,
  "src/logo.webp": "the workspace only holds the file's existence, not its bytes",
};

// ── The assertions that matter ───────────────────────────────

describe("bundleWorkspace", () => {
  it("bundles an HTML entry whose script src is a root-relative URL", async () => {
    // The reported failure, end to end: a repo whose index.html says
    // `<script type="module" src="/src/main.jsx">`. The preloader fetched
    // `src/main.jsx` after stripping the slash; the bundler was handed
    // `/src/main.jsx` and matched no file — so the build named its OWN entry
    // point as "in the repository but its contents were not loaded".
    const files = {
      "index.html": `<div id="root"></div><script type="module" src="/src/main.jsx"></script>`,
      "src/main.jsx": `
        import { createRoot } from "react-dom/client";
        createRoot(document.getElementById("root")).render(null);
      `,
    };

    // The one place an HTML script src becomes a path.
    const resolved = resolveEntryScriptPath({
      htmlPath: "index.html",
      scriptSrc: "/src/main.jsx",
      exists: (path) => createWorkspaceVfs(workspace(files)).exists(path),
      resolveRel: (from, rel) => createWorkspaceVfs(workspace(files)).resolveRel(from, rel),
    });
    expect(resolved).toBe("src/main.jsx");

    const { output } = await bundle(files, true, resolved!);
    expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(output.status).toBe("ready");
  });

  it("gives CSS Modules the class-name mapping the app imports", async () => {
    // `import styles from "./Hero.module.css"` has to yield real names: with
    // a plain CSS loader there is no default export, every `styles.hero` is
    // undefined, and the app renders with no classes — a build that succeeds
    // and a page that looks broken.
    const { output } = await bundle({
      "src/main.tsx": `
        import styles from "./sections/Hero.module.css";
        document.body.className = styles.hero;
      `,
      "src/sections/Hero.module.css": `.hero { color: red; } .title { font-weight: 700; }`,
    });

    expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(output.status).toBe("ready");
    // The class the stylesheet defines is the one the JavaScript asks for.
    const emitted = /\.([A-Za-z0-9_-]*hero[A-Za-z0-9_-]*)/.exec(output.css)?.[1];
    expect(emitted).toBeTruthy();
    expect(output.js).toContain(emitted!);
    expect(output.js).toContain("title");
  });

  it("leaves CSS url() addresses alone instead of resolving them as modules", async () => {
    // Reported from a real repo: every data: URL in every stylesheet became a
    // build error — "`data:image/svg+xml,%3Csvg…` is not a package name, a
    // relative path, or a URL" — for noise textures, chevrons and masks,
    // which are addresses the browser resolves and none of our business.
    const { output } = await bundle({
      "src/main.tsx": `import "./styles.css"; console.log("ok");`,
      "src/styles.css": `
        @import "./theme.css";
        .noise { background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'/%3E%3C/svg%3E"); }
        .chevron { background-image: url("data:image/svg+xml,%3Cpath d='M1 1L5 5'/%3E"); }
        .filtered { filter: url(#noise); }
        .remote { background: url("https://cdn.example/x.png"); }
        .themed { color: var(--brand); }
      `,
      "src/theme.css": `:root { --brand: red; }`,
    });

    expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(output.status).toBe("ready");
    // …and they survive into the bundle, untouched, for the browser to fetch.
    expect(output.css).toContain("data:image/svg+xml");
    expect(output.css).toContain("https://cdn.example/x.png");
    expect(output.css).toContain("#noise");
    expect(output.css).toContain("--brand");
  });

  it("rewrites import.meta.glob so the app does not die before it renders", async () => {
    // The reported failure: `(intermediate value).glob is not a function`
    // while the entry module initialised — an empty frame, and an error that
    // named neither the file nor the api. `import.meta.glob` is a Vite API
    // that Vite rewrites while building.
    const { output } = await bundle({
      "src/main.tsx": `
        import { pages } from "./pages/index";
        console.log(Object.keys(pages));
      `,
      "src/pages/index.ts": `
        export const pages = import.meta.glob("./*.tsx", { eager: true });
      `,
      "src/pages/Home.tsx": `export const Home = "HOME_MARKER";`,
      "src/pages/About.tsx": `export const About = "ABOUT_MARKER";`,
    });

    expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(output.status).toBe("ready");
    // The call is gone, both pages are really in the bundle, and the keys are
    // the ones the app looks modules up by.
    expect(output.js).not.toContain("import.meta.glob(");
    expect(output.js).toContain("HOME_MARKER");
    expect(output.js).toContain("ABOUT_MARKER");
    expect(output.js).toContain('"./Home.tsx"');
  });

  it("names a glob call it cannot rewrite, instead of leaving a cryptic throw", async () => {
    const { output } = await bundle({
      "src/main.tsx": `
        import { mods } from "./dynamic";
        console.log(mods);
      `,
      "src/dynamic.ts": `export const mods = import.meta.glob(\`./pages/\${process.env.NODE_ENV}.tsx\`);`,
    });

    const error = output.diagnostics.find((d) => d.severity === "error");
    expect(error?.message).toContain("src/dynamic.ts");
    expect(error?.message).toContain("computed");
  });

  it("produces one self-contained module with no imports left in it", async () => {
    const { output } = await bundle(APP);
    expect(output.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(output.status).toBe("ready");

    // The whole point: nothing for a browser to resolve at runtime.
    expect(output.js).not.toMatch(/^\s*import\s/m);
    expect(output.js).not.toMatch(/\bfrom\s*["']/);
  });

  it("collapses every React user into ONE instance", async () => {
    const { output, host } = await bundle(APP);
    expect(output.status).toBe("ready");

    // Two importers — the entry, and lucide-react after esm.sh externalized
    // its React — must reach the same module object. The previous design
    // handed that question to the browser's import map; here the module
    // cache answers it, and the fetch log shows it was fetched once.
    expect(host.log.filter((url) => url === REQUESTED.react)).toHaveLength(1);
    expect(output.js.match(/the-one-react/g)).toHaveLength(1);
  });

  it("resolves a host module's own path against the URL it came from", async () => {
    const { output, host } = await bundle(APP);
    expect(output.status).toBe("ready");
    // `react.mjs` imports "./react.chunk.mjs", which resolves against the
    // REDIRECTED url. Resolving it against the requested one — or treating
    // it as a workspace path — fails the build outright.
    expect(host.log).toContain(REACT_CHUNK_URL);
    // The chunk's own value survives into the bundle, so it was really
    // compiled in rather than tree-shaken out of an unused import.
    expect(output.js).toContain("shared-internals");
  });

  it("inlines an asset from its bytes instead of parsing it as source", async () => {
    const { output } = await bundle(APP);
    expect(output.status).toBe("ready");
    // The bug this pins: `vfs:src/assets/x.webp:1 Expected ";" but found
    // "\x14"` — an image's bytes handed to the JavaScript parser.
    expect(output.css).toContain("data:image/webp;base64,");
    expect(output.css).toContain(WEBP_BASE64);
  });

  it("strips vendor directives and still bundles the real stylesheets", async () => {
    const { output } = await bundle(APP);
    expect(output.css).not.toContain("@import");
    expect(output.css).toContain("--brand");
    expect(output.report.strippedCss).toContain("tailwindcss");
  });

  it("fails the build, by name, for an import with no destination", async () => {
    const { output } = await bundle({
      ...APP,
      "src/main.tsx": `import thing from "left-pad";\nexport default thing;`,
    });

    expect(output.status).toBe("error");
    expect(output.diagnostics.some((d) => d.message.includes("left-pad"))).toBe(true);
    expect(output.report.unresolved.get("left-pad")).toContain("package.json");
  });

  it("names a Node built-in as the reason instead of shipping a broken import", async () => {
    const { output } = await bundle({
      ...APP,
      "src/main.tsx": `import fs from "fs";\nexport default fs;`,
    });
    expect(output.status).toBe("error");
    expect(output.report.unresolved.get("fs")).toContain("browser implementation");
  });

  it("names a package the host does not serve, instead of failing silently", async () => {
    const { output } = await bundle({
      ...APP,
      "src/main.tsx": `import ghost from "zustand";\nexport default ghost;`,
    });
    expect(output.status).toBe("error");
    expect(
      output.diagnostics.some((d) => /module host/.test(d.message) && /404/.test(d.message))
    ).toBe(true);
  });

  it("stubs bundler internals rather than failing a project that is otherwise fine", async () => {
    const { output } = await bundle({
      ...APP,
      "src/main.tsx": `import "@vite/client";\nimport { useState } from "react";\nexport const x = useState;`,
    });
    expect(output.status).toBe("ready");
    expect(output.report.stubbed.has("@vite/client")).toBe(true);
  });

  it("reports an asset it could not fetch, and keeps the app running", async () => {
    const { output } = await bundle(APP, false);
    expect(output.status).toBe("ready");
    expect([...output.report.unavailableAssets]).toEqual(["src/logo.webp"]);
    expect(output.diagnostics.some((d) => d.message.includes("placeholder"))).toBe(true);
  });

  it("refuses a file type it has no loader for, by name", async () => {
    const { output } = await bundle({
      ...APP,
      "src/main.tsx": `import weird from "./data.bin";\nexport default weird;`,
      "src/data.bin": "not source code",
    });
    expect(output.status).toBe("error");
    expect(output.diagnostics.some((d) => d.message.includes("data.bin"))).toBe(true);
  });
});

// ── The policy, without esbuild in the way ───────────────────

describe("planRequest", () => {
  const vfs = createWorkspaceVfs(workspace({ "src/main.tsx": "", "src/lib/util.ts": "" }));
  const aliases = readAliasConfig({ configs: new Map(), treePaths: [] });
  const versions: Record<string, string | null> = {
    react: "19.3.0",
    "react-dom": "19.3.0",
    "local-pkg": null,
  };
  const plan = (specifier: string, namespace = WORKSPACE_NS, importer = "src/main.tsx") =>
    planRequest({
      namespace,
      importer,
      specifier,
      kind: "import-statement",
      vfs,
      aliases,
      versions,
      report: createGraphReport(),
    });

  it("sends a declared package to the host, with the version pinned", () => {
    expect(plan("react")).toEqual({ kind: "remote", url: REQUESTED.react });
  });

  it("sends a subpath to the host as a subpath, before the query", () => {
    expect(plan("react-dom/client")).toEqual({ kind: "remote", url: REQUESTED.reactDomClient });
  });

  it("resolves a bare name inside a fetched module through the same table", () => {
    // This is what makes ONE React: a package's own `import "react"` lands
    // on the same URL as the entry's.
    expect(plan("react", REMOTE_NS, REQUESTED.lucide)).toEqual({
      kind: "remote",
      url: REQUESTED.react,
    });
  });

  it("resolves a host module's relative chunk against its own URL", () => {
    expect(plan("./react.chunk.mjs", REMOTE_NS, REACT_BUILD_URL)).toEqual({
      kind: "remote",
      url: REACT_CHUNK_URL,
    });
  });

  it("normalizes an entry point esbuild rewrote", () => {
    const entry = planRequest({
      namespace: "",
      importer: "",
      specifier: "./src/main.tsx",
      kind: "entry-point",
      vfs,
      aliases,
      versions,
      report: createGraphReport(),
    });
    expect(entry).toEqual({ kind: "workspace", path: "src/main.tsx" });
  });

  it("treats a workspace path as a workspace module", () => {
    expect(plan("./lib/util.ts")).toEqual({ kind: "workspace", path: "src/lib/util.ts" });
  });

  it("refuses an undeclared package instead of leaving it to the browser", () => {
    const result = plan("left-pad");
    expect(result.kind).toBe("unresolved");
    if (result.kind === "unresolved") expect(result.reason).toContain("package.json");
  });

  it("refuses a package declared without a publishable version", () => {
    const result = plan("local-pkg");
    expect(result.kind).toBe("unresolved");
    if (result.kind === "unresolved") expect(result.reason).toContain("publishable");
  });
});
