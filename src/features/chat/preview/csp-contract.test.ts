// ============================================================
// Preview CSP Contract — Regression Guard
// ============================================================
// The preview frame is a srcdoc document, so it INHERITS the app's
// Content-Security-Policy rather than getting one of its own. That makes
// two facts depend on each other from opposite ends of the repository:
//
//   • the preview resolves package specifiers through an import map built
//     by ./module-resolution, and injects the CSS plan's runtime scripts
//     (./css-pipeline) — both point at a CDN;
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
// The import map is no longer a literal object in preview-runtime.ts (it is
// derived from the repository's package.json), so this test reads the HOSTS
// from the modules that produce them and checks the policies against every
// one. It also pins the two properties that keep that class of failure
// visible rather than silent.

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
    // The import map and the bridge are inline scripts in the frame
    // document, and an import map CANNOT be external: the spec removed
    // `src` support. Dev must permit them.
    expect(scriptSrc(devPolicy)).toContain("'unsafe-inline'");
  });

  it("composes exactly one inline import map and one inline bridge", () => {
    // Everything else in the frame document is a bundle, a stylesheet or an
    // external script. Keeping the inline surface to these two is what makes
    // the policy requirement above the smallest it can be.
    const importMaps = runtimeSource.match(/<script type="importmap">/g) ?? [];
    expect(importMaps).toHaveLength(1);
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
});
