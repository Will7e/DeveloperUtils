// ============================================================
// Preview Entry Detection — Regression Suite
// ============================================================
// Each case here is a repository shape the previous fixed-list detector
// got wrong, and each wrong answer had the same user-visible result:
// "the preview does not run my project".
// ============================================================

import { describe, it, expect } from "vitest";
import { detectEntry, unsupportedProjectReason } from "./entry";
import type { WorkspaceState } from "../types";

/** Minimal workspace fixture: paths in the tree, contents in `files` */
function workspace(paths: string[], files: Record<string, string> = {}): WorkspaceState {
  return {
    conversationId: "c1",
    owner: "acme",
    repo: "app",
    branch: "main",
    baseCommitSha: "abc",
    workingBranch: null,
    tree: paths.map((path) => ({ path, type: "blob" as const })),
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          path,
          content,
          baseContent: "",
          baseSha: null,
          status: "modified" as const,
          updatedAt: 0,
        },
      ])
    ),
    updatedAt: 0,
  };
}

describe("detectEntry", () => {
  it("finds a Vite project's index.html and its module script", () => {
    const entry = detectEntry(
      workspace(["index.html", "src/main.tsx"], {
        "index.html": '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      })
    );
    expect(entry).toEqual({ kind: "html", path: "index.html", scriptSrc: "/src/main.tsx" });
  });

  it("prefers the type=module script over an earlier plain script", () => {
    // The old regex took the FIRST src= it found, so this page previewed
    // the analytics snippet instead of the app.
    const entry = detectEntry(
      workspace(["index.html"], {
        "index.html":
          '<head><script src="/analytics.js"></script></head>' +
          '<body><script type="module" src="/src/app.tsx"></script></body>',
      })
    );
    expect(entry?.scriptSrc).toBe("/src/app.tsx");
  });

  it("reads src that appears after type", () => {
    const entry = detectEntry(
      workspace(["index.html"], {
        "index.html": '<script type="module" defer src="./main.tsx"></script>',
      })
    );
    expect(entry?.scriptSrc).toBe("./main.tsx");
  });

  it("ignores remote script URLs", () => {
    const entry = detectEntry(
      workspace(["index.html"], {
        "index.html": '<script src="https://cdn.example.com/lib.js"></script>',
      })
    );
    expect(entry?.scriptSrc).toBeUndefined();
  });

  it("honours a configured vite root", () => {
    const entry = detectEntry(
      workspace(["src/index.html", "src/main.tsx"], {
        "src/index.html": '<script type="module" src="./main.tsx"></script>',
      }),
      { root: "src" }
    );
    expect(entry?.path).toBe("src/index.html");
  });

  it("falls back to the repository root when the configured root is absent", () => {
    const entry = detectEntry(workspace(["index.html"]), { root: "apps/web" });
    expect(entry?.path).toBe("index.html");
  });

  it("finds a monorepo's nested index.html", () => {
    const entry = detectEntry(
      workspace(["apps/web/index.html", "apps/web/src/main.tsx", "package.json"])
    );
    expect(entry?.path).toBe("apps/web/index.html");
  });

  it("picks the SHALLOWEST index.html when several exist", () => {
    const entry = detectEntry(
      workspace(["docs/examples/index.html", "index.html", "apps/web/index.html"])
    );
    expect(entry?.path).toBe("index.html");
  });

  it("prefers a real index.html over public/index.html", () => {
    // `public/` is copied to the output root, so a repository with both
    // means the top-level file is the source.
    expect(detectEntry(workspace(["index.html", "public/index.html"]))?.path).toBe("index.html");
  });

  it("falls back to public/index.html when that is all there is", () => {
    expect(detectEntry(workspace(["public/index.html"]))?.path).toBe("public/index.html");
  });

  it("finds a JS/TS entry when there is no HTML at all", () => {
    expect(detectEntry(workspace(["src/main.tsx"]))).toEqual({
      kind: "js",
      path: "src/main.tsx",
    });
    expect(detectEntry(workspace(["main.ts"]))?.path).toBe("main.ts");
  });

  it("prefers src/main.tsx over a bare index.js", () => {
    expect(detectEntry(workspace(["index.js", "src/main.tsx"]))?.path).toBe("src/main.tsx");
  });

  it("uses the loaded file contents even when the tree is empty", () => {
    const entry = detectEntry(workspace([], { "index.html": "<div id=app></div>" }));
    expect(entry?.path).toBe("index.html");
  });

  it("returns null for a workspace with nothing recognizable", () => {
    expect(detectEntry(workspace(["README.md", "docs/guide.md"]))).toBeNull();
    expect(detectEntry(workspace([]))).toBeNull();
  });
});

describe("unsupportedProjectReason", () => {
  it("names Next.js instead of claiming there is no entry", () => {
    const reason = unsupportedProjectReason(
      workspace(["package.json", "app/page.tsx"], {
        "package.json": JSON.stringify({ dependencies: { next: "^15.0.0" } }),
      })
    );
    expect(reason).toContain("Next.js");
    expect(reason).toContain("Node server");
  });

  it("detects a framework from its config file alone", () => {
    expect(
      unsupportedProjectReason(workspace(["next.config.mjs", "package.json"]))
    ).toContain("Next.js");
    expect(
      unsupportedProjectReason(workspace(["nuxt.config.ts", "package.json"]))
    ).toContain("Nuxt");
  });

  it("detects Astro, SvelteKit and Angular", () => {
    const withDep = (dep: string) =>
      workspace(["package.json"], {
        "package.json": JSON.stringify({ dependencies: { [dep]: "^1.0.0" } }),
      });
    expect(unsupportedProjectReason(withDep("astro"))).toContain("Astro");
    expect(unsupportedProjectReason(withDep("@sveltejs/kit"))).toContain("compiler");
    expect(unsupportedProjectReason(withDep("@angular/core"))).toContain("compiler");
  });

  it("stays quiet for an ordinary Vite project", () => {
    expect(
      unsupportedProjectReason(
        workspace(["package.json", "index.html"], {
          "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }),
        })
      )
    ).toBeNull();
  });

  it("stays quiet when package.json is missing or unreadable", () => {
    expect(unsupportedProjectReason(workspace(["index.html"]))).toBeNull();
    expect(
      unsupportedProjectReason(workspace(["package.json"], { "package.json": "{not json" }))
    ).toBeNull();
  });
});
