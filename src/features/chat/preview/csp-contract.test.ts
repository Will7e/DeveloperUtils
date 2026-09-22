// ============================================================
// Preview CSP Contract — Regression Guard
// ============================================================
// The preview frame is a srcdoc document, so it INHERITS the app's
// Content-Security-Policy rather than getting one of its own. That makes
// two facts depend on each other from opposite ends of the repository:
//
//   • the preview FETCHES package source from a CDN during the build
//     (./cdn and ./graph) and injects the CSS plan's runtime scripts
//     (./css-pipeline) — both point at that CDN;
//   • index.html (dev) and vercel.json (production) decide whether that CDN
//     may be loaded at all.
//
// They drifted once: esm.sh was listed in font-src and missing from
// script-src, so the bundle's very first `import "react"` was blocked, the
// module graph never executed, and every preview frame rendered as a black
// rectangle with no error in the pane, the console, or the agent's feedback.
// Nothing in the suite could see it, because the failing judge was the
// browser.
//
// The hosts are derived from the repository's own package.json by ./cdn and
// ./css-pipeline, so this test reads them from the modules that produce them
// and checks the policies against every one. It also pins the two properties
// that keep that class of failure visible rather than silent.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PREVIEW_CDN } from "./module-resolution";
import { detectCssToolchain, planCss } from "./css-pipeline";
import { parsePackageJson } from "./module-resolution";

const root = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

const runtimeSource = readFileSync(
  fileURLToPath(new URL("./preview-runtime.ts", import.meta.url)),
  "utf8"
);
const devPolicy = readFileSync(root("index.html"), "utf8");
const prodPolicy = readFileSync(root("vercel.json"), "utf8");

/**
 * Every remote host the preview can load a script or module from:
 * the module host used by the import map, plus anything the CSS plan
 * injects.
 */
function previewRuntimeHosts(): string[] {
  const hosts = new Set<string>([new URL(PREVIEW_CDN).host]);

  // The Tailwind browser build is the one runtime script the CSS plan can
  // add, and it is loaded from the module host.
  const toolchain = detectCssToolchain({
    manifest: parsePackageJson(JSON.stringify({ devDependencies: { tailwindcss: "^4.2.4" } })),
    cssFiles: [{ path: "src/index.css", content: '@import "tailwindcss";' }],
  });
  for (const script of planCss(toolchain).scripts) {
    hosts.add(new URL(script).host);
  }
  return [...hosts];
}

/**
 * The script-src DIRECTIVE of a policy string. Prose that merely mentions
 * script-src (both policy files carry explanatory comments) is not one, so
 * the directive is identified by the `'self'` every real policy lists.
 */
function scriptSrc(policy: string): string {
  const directives = [...policy.matchAll(/script-src ([^;"\n]*)/g)].map((m) => m[1]!);
  const directive = directives.find((d) => d.includes("'self'"));
  expect(directive, "the policy must declare script-src").toBeTruthy();
  return directive!;
}

describe("preview CSP contract", () => {
  it("keeps every preview module host in sync with the policies", () => {
    const hosts = previewRuntimeHosts();
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(scriptSrc(devPolicy), `index.html script-src must allow ${host}`).toContain(host);
      expect(scriptSrc(prodPolicy), `vercel.json script-src must allow ${host}`).toContain(host);
    }
  });

  it("never lets the two policies diverge on the module hosts", () => {
    // A host allowed in dev but not in production (or the reverse) means a
    // preview that works locally and is blank once deployed.
    const dev = scriptSrc(devPolicy);
    const prod = scriptSrc(prodPolicy);
    for (const host of previewRuntimeHosts()) {
      expect(dev.includes(host), `${host} in dev`).toBe(prod.includes(host));
    }
  });

  it("allows inline scripts in the DEV policy, which the preview document needs", () => {
    // The bridge and the bundle are inline scripts in the frame document.
    // Dev must permit them.
    expect(scriptSrc(devPolicy)).toContain("'unsafe-inline'");
  });

  it("ships no import map at all, and exactly one inline bridge", () => {
    // The preview used to leave bare specifiers in the bundle and let the
    // BROWSER resolve them against an inline import map. That resolver is
    // gone — the bundler fetches and compiles every package itself — so an
    // import map would have nothing left to resolve. Its absence is the
    // point: it retires the whole class of runtime resolution failures
    // (an entry the platform refuses to match, "blocked due to
    // backtracking", a specifier that reaches the frame with no
    // destination).
    expect(runtimeSource).not.toContain('type="importmap"');
    // The bridge is the one inline script left, which is what keeps the
    // policy requirement above as small as it is.
    const bridgeInjections = runtimeSource.match(/\$\{bridgeSource\.toString\(\)\}/g) ?? [];
    expect(bridgeInjections).toHaveLength(1);
  });

  it("reports a CSP violation instead of failing silently", () => {
    // The frame must NAME a blocked directive, a blocked URI and the fix.
    // The drift that produced a black rectangle was invisible precisely
    // because nothing on either side could observe the block.
    expect(runtimeSource).toContain("securitypolicyviolation");
    expect(runtimeSource).toContain("Content-Security-Policy blocked");
  });

  it("reports a bundle that loads but renders nothing", () => {
    // The other half of "the preview is broken": module instantiation
    // errors do not reliably reach window.onerror, so an empty root is the
    // only evidence there is.
    expect(runtimeSource).toContain("rendered nothing");
  });

  it("allows the in-browser type checker to reach its compiler and lib files", () => {
    // The type check loads the compiler as a MODULE (script-src) and
    // TypeScript's own lib .d.ts files as TEXT (connect-src). Both are new
    // runtime dependencies of the agent, so both belong under the same
    // contract as the preview's module host.
    const compilerHost = new URL(PREVIEW_CDN).host; // esm.sh — the compiler
    const libHost = "cdn.jsdelivr.net"; // TypeScript's lib .d.ts text
    expect(scriptSrc(devPolicy)).toContain(compilerHost);
    expect(scriptSrc(prodPolicy)).toContain(compilerHost);
    for (const policy of [devPolicy, prodPolicy]) {
      const connect = [...policy.matchAll(/connect-src ([^;"\n]*)/g)]
        .map((m) => m[1]!)
        .find((d) => d.includes("*") || d.includes("self"));
      expect(connect, "the policy must declare connect-src").toBeTruthy();
      // A pinned allowlist is fine as long as it includes the lib host; an
      // open one already covers it.
      expect(connect!.includes("*") || connect!.includes(libHost)).toBe(true);
    }
  });

  it("allows the app to FRAME a preview served from its own origin", () => {
    // A published preview is a real document on a different origin, so
    // framing it is governed by `frame-src` — not by the `child-src` that
    // used to cover the srcdoc frame. A policy that forgets it blocks the
    // frame: the pane goes empty and the only explanation is in a directive
    // that has nothing to do with the preview's own code.
    const policies: Array<[string, string]> = [
      ["index.html", devPolicy],
      ["vercel.json", prodPolicy],
    ];
    for (const [source, policy] of policies) {
      const frameSrc = [...policy.matchAll(/frame-src ([^;"\n]*)/g)].map((m) => m[1]!)[0];
      expect(frameSrc, `${source} must declare frame-src`).toBeTruthy();
      expect(
        frameSrc!.includes("http://127.0.0.1:*") || frameSrc!.includes("http://localhost:*"),
        `${source} frame-src must allow a locally hosted preview`
      ).toBe(true);
    }
  });
});
