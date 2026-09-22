// ============================================================
// Preview CSS Pipeline — Regression Suite
// ============================================================
// Two behaviours are load-bearing. First, a Tailwind entry file must not
// break the bundle (it starts with `@import "tailwindcss"`, which esbuild
// reads as a package import that cannot resolve). Second, whatever the
// preview CANNOT style has to be reported — an unstyled app that says
// nothing is indistinguishable from a broken one.
// ============================================================

import { describe, it, expect } from "vitest";
import { detectCssToolchain, planCss, stripVendorCss } from "./css-pipeline";
import { parsePackageJson } from "./module-resolution";

const manifestWith = (deps: Record<string, string>) =>
  parsePackageJson(JSON.stringify({ dependencies: deps }));

describe("detectCssToolchain", () => {
  it("detects Tailwind v4 from the @import form in CSS", () => {
    const toolchain = detectCssToolchain({
      manifest: manifestWith({}),
      cssFiles: [{ path: "src/index.css", content: '@import "tailwindcss";\n' }],
    });
    expect(toolchain.tailwind?.major).toBe(4);
  });

  it("detects Tailwind v4 from the declared version", () => {
    const toolchain = detectCssToolchain({
      manifest: manifestWith({ tailwindcss: "^4.2.4" }),
    });
    expect(toolchain.tailwind?.major).toBe(4);
    expect(toolchain.tailwind?.version).toBe("4.2.4");
  });

  it("detects Tailwind v3 from @tailwind directives and from a config file", () => {
    expect(
      detectCssToolchain({
        manifest: manifestWith({}),
        cssFiles: [{ path: "src/app.css", content: "@tailwind base;\n@tailwind utilities;\n" }],
      }).tailwind?.major
    ).toBe(3);
    expect(
      detectCssToolchain({ manifest: manifestWith({}), configPaths: ["tailwind.config.js"] })
        .tailwind?.major
    ).toBe(3);
  });

  it("detects a versionless Tailwind declaration and refuses to guess a major", () => {
    const toolchain = detectCssToolchain({ manifest: manifestWith({ tailwindcss: "workspace:*" }) });
    expect(toolchain.tailwind).not.toBeNull();
    expect(toolchain.tailwind?.version).toBeNull();
    // v3 and v4 class semantics differ, so an unknown version must not be
    // guessed into a compiler that would restyle the app incorrectly.
    expect(toolchain.tailwind?.major).toBe(0);
    const plan = planCss(toolchain);
    expect(plan.runtimeTailwind).toBe(false);
    expect(plan.scripts).toEqual([]);
    expect(plan.diagnostics[0]?.message).toContain("could not be determined");
  });

  it("reports no Tailwind for a plain-CSS project", () => {
    expect(detectCssToolchain({ manifest: manifestWith({ react: "^19.0.0" }) }).tailwind).toBeNull();
  });

  it("detects preprocessors by dependency and by file extension", () => {
    const byDep = detectCssToolchain({ manifest: manifestWith({ sass: "^1.0.0" }) });
    expect(byDep.sass).toBe(true);
    const byFile = detectCssToolchain({
      manifest: manifestWith({}),
      cssFiles: [{ path: "src/styles/main.scss", content: "$x: 1;" }],
    });
    expect(byFile.sass).toBe(true);
  });

  it("lists the PostCSS plugins that will not run", () => {
    const toolchain = detectCssToolchain({
      manifest: manifestWith({ postcss: "^8.0.0", autoprefixer: "^10.0.0" }),
    });
    expect(toolchain.postcssPlugins).toEqual(["postcss", "autoprefixer"]);
  });
});

describe("planCss", () => {
  it("loads Tailwind's browser build for v4 — from a host the app policy already allows", () => {
    const plan = planCss(
      detectCssToolchain({
        manifest: manifestWith({ tailwindcss: "^4.2.4" }),
        cssFiles: [{ path: "src/index.css", content: '@import "tailwindcss";' }],
      })
    );
    expect(plan.runtimeTailwind).toBe(true);
    expect(plan.scripts).toHaveLength(1);
    // The CSP contract test asserts this host is allowed in BOTH policies;
    // pointing the plan anywhere else would reintroduce the black frame.
    expect(new URL(plan.scripts[0] as string).origin).toBe("https://esm.sh");
    expect(plan.diagnostics.some((d) => d.message.includes("Tailwind v4"))).toBe(true);
  });

  it("does NOT silently widen styling claims for v3", () => {
    const plan = planCss(
      detectCssToolchain({
        manifest: manifestWith({ tailwindcss: "^3.4.0" }),
        configPaths: ["tailwind.config.js"],
      })
    );
    expect(plan.runtimeTailwind).toBe(false);
    expect(plan.scripts).toEqual([]);
    const message = plan.diagnostics.map((d) => d.message).join(" ");
    expect(message).toContain("Tailwind v3");
    expect(message).toContain("NOT applied");
  });

  it("says when a preprocessor's styles are absent", () => {
    const plan = planCss(detectCssToolchain({ manifest: manifestWith({ sass: "^1.0.0" }) }));
    expect(plan.diagnostics[0]?.message).toContain("Sass/SCSS");
    expect(plan.diagnostics[0]?.message).toContain("absent");
  });

  it("mentions PostCSS only when it is the whole story", () => {
    const withTailwind = planCss(
      detectCssToolchain({
        manifest: manifestWith({ tailwindcss: "^4.0.0", postcss: "^8.0.0" }),
      })
    );
    expect(withTailwind.diagnostics.some((d) => d.message.includes("PostCSS"))).toBe(false);
    const postcssOnly = planCss(detectCssToolchain({ manifest: manifestWith({ postcss: "^8.0.0" }) }));
    expect(postcssOnly.diagnostics.some((d) => d.message.includes("PostCSS"))).toBe(true);
  });

  it("is silent for a plain-CSS project", () => {
    const plan = planCss(detectCssToolchain({ manifest: manifestWith({}) }));
    expect(plan.diagnostics).toEqual([]);
    expect(plan.scripts).toEqual([]);
  });
});

describe("stripVendorCss", () => {
  const v4Plan = planCss(
    detectCssToolchain({ manifest: manifestWith({ tailwindcss: "^4.2.4" }) })
  );

  it("removes Tailwind v3 directives when the toolchain asks for it", () => {
    const { css, stripped } = stripVendorCss(
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nbody { color: red; }",
      v4Plan
    );
    expect(css).not.toContain("@tailwind");
    expect(css).toContain("body { color: red; }");
    expect(stripped.filter((s) => s === "@tailwind")).toHaveLength(3);
  });

  it("removes a bare @import that the browser could never fetch", () => {
    const { css, stripped } = stripVendorCss('@import "tailwindcss";\nbody { margin: 0; }', v4Plan);
    expect(css).not.toContain('@import "tailwindcss"');
    expect(css).toContain("bare package import");
    expect(stripped).toContain("tailwindcss");
  });

  it("KEEPS a relative @import, which is a real file in the workspace", () => {
    const source = '@import "./tokens.css";\n@import "./base/reset.css";';
    const { css, stripped } = stripVendorCss(source, v4Plan);
    expect(css).toBe(source);
    expect(stripped).toEqual([]);
  });

  it("keeps a real URL import, fonts included", () => {
    const source = '@import url("https://fonts.googleapis.com/css2?family=Geist");';
    expect(stripVendorCss(source, v4Plan).css).toBe(source);
  });

  it("leaves a plain stylesheet byte-identical", () => {
    const source = "body {\n  margin: 0;\n}\n.a::before { content: '*/'; }";
    const { css, stripped } = stripVendorCss(source, v4Plan);
    expect(css).toBe(source);
    expect(stripped).toEqual([]);
  });

  it("does not touch @tailwind text when the toolchain is not Tailwind", () => {
    const plan = planCss(detectCssToolchain({ manifest: manifestWith({}) }));
    const source = "@tailwind base;";
    expect(stripVendorCss(source, plan).css).toBe(source);
  });
});
