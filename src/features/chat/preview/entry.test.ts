// ============================================================
// Preview Entry Detection — Regression Suite
// ============================================================
// Each case here is a repository shape the previous fixed-list detector
// got wrong, and each wrong answer had the same user-visible result:
// "the preview does not run my project".
// ============================================================

import { describe, it, expect } from "vitest";
import {
  detectEntry,
  resolveEntryScriptPath,
  unsupportedProjectReason,
  workspaceEntryPath,
} from "./entry";
import { createWorkspaceVfs } from "./vfs";
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

// ── The entry script's path ──────────────────────────────────
//
// The failure this guards, reported from a real repo: the build named its
// OWN entry point as a file whose contents were never loaded. The preloader
// had fetched `src/main.jsx`; the bundler looked up `/src/main.jsx`, because
// an HTML script src is a URL and both callers were reading it differently.

describe("resolveEntryScriptPath", () => {
  /** A workspace whose tree and contents the real VFS resolves through */
  function vfsFor(paths: string[], files: Record<string, string> = {}) {
    return createWorkspaceVfs(workspace(paths, files));
  }

  function resolveIn(vfs: ReturnType<typeof vfsFor>, htmlPath: string, scriptSrc: string) {
    return resolveEntryScriptPath({
      htmlPath,
      scriptSrc,
      exists: (path) => vfs.exists(path),
      resolveRel: (from, rel) => vfs.resolveRel(from, rel),
    });
  }

  it("resolves the Vite convention — root-relative — to a file it can read", () => {
    const vfs = vfsFor(["index.html", "src/main.jsx"], { "src/main.jsx": "console.log(1)" });
    const resolved = resolveIn(vfs, "index.html", "/src/main.jsx");
    expect(resolved).toBe("src/main.jsx");
    // The whole point: the bundler reads the same file the preloader fetched.
    expect(vfs.read(resolved!)).toBe("console.log(1)");
  });

  it("resolves a monorepo, where the same URL means the document's own directory", () => {
    const vfs = vfsFor(["apps/web/index.html", "apps/web/src/main.jsx"], {
      "apps/web/src/main.jsx": "app",
    });
    const resolved = resolveIn(vfs, "apps/web/index.html", "/src/main.jsx");
    expect(resolved).toBe("apps/web/src/main.jsx");
    expect(vfs.read(resolved!)).toBe("app");
  });

  it("handles a relative src, an omitted extension and a query suffix", () => {
    const vfs = vfsFor(["src/index.html", "src/main.tsx"], { "src/main.tsx": "ok" });
    expect(resolveIn(vfs, "src/index.html", "./main.tsx")).toBe("src/main.tsx");
    // An HTML attribute may omit the extension; the VFS supplies candidates.
    expect(resolveIn(vfs, "src/index.html", "./main")).toBe("src/main.tsx");
    // `?v=2` names a cache key, not a file.
    expect(resolveIn(vfs, "src/index.html", "/src/main.tsx?v=2")).toBe("src/main.tsx");
  });

  it("refuses a src that is not a workspace file instead of guessing", () => {
    const vfs = vfsFor(["src/index.html"]);
    for (const src of [
      "https://cdn.example/app.js",
      "//cdn.example/app.js",
      "data:text/javascript,1",
      "/src/gone.jsx",
      "./gone.jsx",
      "",
    ]) {
      expect(resolveIn(vfs, "src/index.html", src), src).toBeNull();
    }
    // …and the shared reading of a src is what both callers agree on.
    expect(workspaceEntryPath("/src/main.jsx")).toBe("src/main.jsx");
    expect(workspaceEntryPath(undefined)).toBeNull();
  });
});

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
