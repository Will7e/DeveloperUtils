import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import {
  MAX_PREVIEW_ISSUES,
  detectDevServer,
  notePreviewMessageForTest,
  packageJsonOf,
  previewEvidenceNote,
  previewState,
  resetPreview,
  startPreview,
  stopPreview,
} from "./preview-bridge";
import { planMount } from "./mount-plan";
import {
  adoptRuntimeForTest,
  resetContainerHost,
  type ContainerRuntime,
} from "./container-host";
import { resetContainerQueue } from "./container-executor";

const globals = globalThis as unknown as Record<string, unknown>;
let isolated: unknown;
let secure: unknown;

const PKG = JSON.stringify({
  name: "demo",
  scripts: { build: "vite build", test: "vitest run" },
});

describe("detectDevServer — declared scripts only", () => {
  it("finds the dev script and runs it through npm", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite", build: "vite build" } });
    expect(detectDevServer({ packageJson: pkg })).toEqual({ command: "npm run dev", script: "dev" });
  });

  it("prefers `dev` over a generic `start`, and any of them over `preview`", () => {
    const both = JSON.stringify({ scripts: { start: "node server.js", dev: "vite" } });
    expect(detectDevServer({ packageJson: both })?.script).toBe("dev");
    const previewOnly = JSON.stringify({ scripts: { preview: "vite preview" } });
    expect(detectDevServer({ packageJson: previewOnly })?.script).toBe("preview");
  });

  it("honours the declared package manager rather than assuming npm", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite" }, packageManager: "pnpm@9.0.0" });
    expect(detectDevServer({ packageJson: pkg })?.command).toBe("pnpm dev");
    const yarn = JSON.stringify({ scripts: { start: "vite" }, packageManager: "yarn@4.1.1" });
    expect(detectDevServer({ packageJson: yarn })?.command).toBe("yarn start");
  });

  it("returns null rather than guessing when no server script is declared", () => {
    // The whole point: `npx vite` would be this app guessing from a dependency
    // list, and a guess that starts the wrong thing gets blamed on the project.
    expect(detectDevServer({ packageJson: PKG })).toBeNull();
    expect(detectDevServer({ packageJson: "not json" })).toBeNull();
    expect(detectDevServer({ packageJson: null })).toBeNull();
  });
});

describe("packageJsonOf", () => {
  it("reads the manifest out of the tree that is about to be mounted", () => {
    const plan = planMount({
      base: [{ path: "package.json", content: PKG }],
      changes: [],
    });
    expect(packageJsonOf(plan)).toBe(PKG);
  });

  it("is null when the revision has no manifest", () => {
    const plan = planMount({ base: [{ path: "README.md", content: "# hi" }], changes: [] });
    expect(packageJsonOf(plan)).toBeNull();
  });
});

describe("preview evidence", () => {
  beforeEach(() => resetPreview());

  it("is silent when nothing has gone wrong", () => {
    expect(previewEvidenceNote()).toBe("");
  });

  it("reports runtime problems as evidence about the RUNNING app", () => {
    notePreviewMessageForTest({ type: "PREVIEW_CONSOLE_ERROR", args: ["Failed to fetch /api"] });
    notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "TypeError: x is not a function" });
    const note = previewEvidenceNote();
    expect(note).toContain("2 problem(s)");
    expect(note).toContain("1 exception(s)");
    expect(note).toContain("TypeError: x is not a function");
    expect(note).toContain("not the build");
  });

  it("keeps only the newest console entries, so hot reload cannot unbounded-grow it", () => {
    for (let i = 0; i < MAX_PREVIEW_ISSUES + 10; i += 1) {
      notePreviewMessageForTest({ type: "PREVIEW_CONSOLE_ERROR", args: [`error ${i}`] });
    }
    const issues = previewState().issues;
    expect(issues).toHaveLength(MAX_PREVIEW_ISSUES);
    expect(issues[issues.length - 1]?.message).toBe(`error ${MAX_PREVIEW_ISSUES + 9}`);
  });
});

describe("startPreview — the harness owns the dev server, including the one already running", () => {
  beforeEach(() => {
    isolated = globals.crossOriginIsolated;
    secure = globals.isSecureContext;
    globals.crossOriginIsolated = true;
    globals.isSecureContext = true;
    resetPreview();
    resetContainerHost();
    resetContainerQueue();
  });

  afterEach(() => {
    globals.crossOriginIsolated = isolated;
    globals.isSecureContext = secure;
    adoptRuntimeForTest(null);
    resetPreview();
    resetContainerHost();
    resetContainerQueue();
  });

  /**
   * A runtime that answers `server-ready` for the dev server it was asked to
   * start, and whose dev process never exits on its own — which is what a dev
   * server is. `killed` is how the test sees whether Stop reached it.
   */
  function devRuntime(devProcesses: { killed: boolean }[]) {
    let serverReady: ((port: number, url: string) => void) | null = null;
    const process = () => {
      const record = { killed: false };
      devProcesses.push(record);
      let resolveExit: (code: number) => void = () => {};
      const exit = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      return {
        exit,
        output: () => new ReadableStream<string>({ start: (c) => c.enqueue("VITE ready in 300ms\n") }),
        kill: () => {
          record.killed = true;
          resolveExit(137);
        },
      };
    };
    const simple = (output: string, code: number) => {
      let resolveExit: (value: number) => void = () => {};
      const exit = new Promise<number>((resolve) => {
        resolveExit = resolve;
        setTimeout(() => resolve(code), 0);
      });
      return {
        exit,
        output: () => new ReadableStream<string>({ start: (c) => { c.enqueue(output); c.close(); } }),
        kill: () => resolveExit(137),
      };
    };
    const runtime = {
      mount: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      fs: { mkdir: vi.fn(async () => {}), rm: vi.fn(async () => {}) },
      spawn: vi.fn(async (command: string, args: string[]) => {
        const line = `${command} ${args.join(" ")}`;
        if (line.includes("node --version")) return simple("v22.0.0\n", 0);
        if (line.includes("npm ci")) return simple("added 1 package\n", 0);
        // The dev server answers on a later turn of the loop, so the subscriber
        // in `waitForServerReady` is registered by the time it fires.
        setTimeout(() => serverReady?.(3000, "http://localhost:3000/"), 0);
        return process();
      }),
      on: vi.fn((event: string, listener: (port: number, url: string) => void) => {
        if (event === "server-ready") serverReady = listener;
        return () => {};
      }),
      teardown: vi.fn(async () => {}),
    };
    return runtime as unknown as ContainerRuntime;
  }

  const DEV_PLAN = () =>
    planMount({
      base: [
        { path: "package.json", content: JSON.stringify({ scripts: { dev: "vite" } }) },
        { path: "package-lock.json", content: "{}" },
      ],
      changes: [],
    });

  it("starts the declared script and reports where it answered", async () => {
    const processes: { killed: boolean }[] = [];
    adoptRuntimeForTest(devRuntime(processes));

    const started = await startPreview({ plan: DEV_PLAN(), revision: 1 });
    expect(started.ok).toBe(true);
    expect(previewState().status).toBe("running");
    expect(previewState().url).toBe("http://localhost:3000/");
    expect(previewState().command).toBe("npm run dev");
    expect(processes[0]?.killed).toBe(false);
  });

  it("kills the running server before starting another one", async () => {
    // A second dev server on the same port is the failure this module exists to
    // prevent, and `Restart` is the most ordinary way to cause it: the first
    // process was orphaned and `process` — the only handle Stop has — moved to
    // the newer of two servers competing for the port.
    const processes: { killed: boolean }[] = [];
    adoptRuntimeForTest(devRuntime(processes));

    const first = await startPreview({ plan: DEV_PLAN(), revision: 1 });
    expect(first.ok).toBe(true);
    const second = await startPreview({ plan: DEV_PLAN(), revision: 1 });
    expect(second.ok).toBe(true);

    expect(processes).toHaveLength(2);
    expect(processes[0]?.killed).toBe(true);
    expect(processes[1]?.killed).toBe(false);
    expect(previewState().status).toBe("running");
    expect(previewState().url).toBe("http://localhost:3000/");
  });

  it("reaches the running server on stop, and leaves the workspace alone", async () => {
    const processes: { killed: boolean }[] = [];
    adoptRuntimeForTest(devRuntime(processes));

    await startPreview({ plan: DEV_PLAN(), revision: 1 });
    stopPreview("stopped by the test");

    expect(processes[0]?.killed).toBe(true);
    expect(previewState().status).toBe("stopped");
    expect(previewState().url).toBeNull();
  });
});

describe("the mounted tree is what the plan says it is", () => {
  it("mounts nested paths as directories", () => {
    const plan = planMount({
      base: [
        { path: "src/a.ts", content: "export const a = 1;" },
        { path: "package.json", content: PKG },
      ],
      changes: [],
    });
    const tree = plan.tree as FileSystemTree;
    const src = tree.src as { directory: FileSystemTree };
    expect(Object.keys(src.directory)).toEqual(["a.ts"]);
  });
});
