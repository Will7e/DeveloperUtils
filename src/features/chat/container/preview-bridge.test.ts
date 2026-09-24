import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import {
  MAX_PREVIEW_ISSUES,
  describeDevServerExit,
  detectDevServer,
  diagnoseDevServerFailure,
  notePreviewMessageForTest,
  packageJsonOf,
  previewEvidenceNote,
  previewState,
  resetPreview,
  startPreview,
  stopPreview,
} from "./preview-bridge";
import { planMount } from "./mount-plan";
import { resetContainerHost, setContainerModuleLoader, type ContainerRuntime } from "./container-host";
import { resetContainerQueue, runInContainer } from "./container-executor";

const globals = globalThis as unknown as Record<string, unknown>;
let isolated: unknown;
let secure: unknown;

const PKG = JSON.stringify({
  name: "demo",
  scripts: { build: "vite build", test: "vitest run" },
});

/** Waits for a condition the module satisfies on a later turn of the loop */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the condition never became true");
}

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
    setContainerModuleLoader(() => import("@webcontainer/api"));
    resetPreview();
    resetContainerHost();
    resetContainerQueue();
  });

  /**
   * A runtime that answers `server-ready` for the dev server it was asked to
   * start, and whose dev process never exits on its own — which is what a dev
   * server is. `killed` is how the test sees whether Stop reached it.
   *
   * Installed through the module loader rather than adopted directly, because the
   * host only subscribes to `server-ready` on the boot path: an adopted runtime
   * would never emit anything, and the test would be asserting against a preview
   * that could not have started at all.
   */
  function bootWith(devProcesses: { killed: boolean }[]): void {
    const runtime = devRuntime(devProcesses);
    const boot = vi.fn(async () => runtime);
    setContainerModuleLoader(
      async () => ({ WebContainer: { boot } }) as unknown as typeof import("@webcontainer/api")
    );
  }

  /**
   * A runtime whose dev script exits straight away, having printed `output`.
   *
   * This is the failure that shipped with no test of its own: a dev script that
   * dies on startup is the most common preview failure there is, and it reported
   * itself as "exited before it served anything" — with the exit status discarded
   * and the cause still sitting unread in the output stream.
   */
  function bootWithDevScript(devScript: { output: string; code: number | null; broken?: boolean }): void {
    const runtime = devRuntime([], devScript);
    const boot = vi.fn(async () => runtime);
    setContainerModuleLoader(
      async () => ({ WebContainer: { boot } }) as unknown as typeof import("@webcontainer/api")
    );
  }

  function devRuntime(
    devProcesses: { killed: boolean }[],
    devScript?: { output: string; code: number | null; broken?: boolean }
  ) {
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
        output: new ReadableStream<string>({ start: (c) => c.enqueue("VITE ready in 300ms\n") }),
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
        output: new ReadableStream<string>({ start: (c) => { c.enqueue(output); c.close(); } }),
        kill: () => resolveExit(137),
      };
    };
    // A dev script whose output stream can never be read at all: the reader
    // rejects, which is the one failure that used to be indistinguishable from a
    // command that printed nothing.
    const brokenOutput = () => {
      const exit = new Promise<number>((resolve) => {
        setTimeout(() => resolve(1), 0);
      });
      return {
        exit,
        output: new ReadableStream<string>({
          start: (controller) => controller.error(new Error("the stream is gone")),
        }),
        kill: () => undefined,
      };
    };
    const runtime = {
      mount: vi.fn(async () => {}),
      fs: {
        writeFile: vi.fn(async () => {}),
        mkdir: vi.fn(async () => {}),
        rm: vi.fn(async () => {}),
      },
      spawn: vi.fn(async (command: string, args: string[]) => {
        const line = `${command} ${args.join(" ")}`;
        if (line.includes("node --version")) return simple("v22.0.0\n", 0);
        if (line.includes("npm ci")) return simple("added 1 package\n", 0);
        // A COMMAND (as opposed to the dev server below): it finishes, which is
        // what lets a test drive a second thread's claim through the executor.
        if (line.includes("npm test")) return simple("2 passed\n", 0);
        // The dev server answers on a later turn of the loop, so the subscriber
        // in `waitForServerReady` is registered by the time it fires.
        if (devScript) {
          if (devScript.broken) return brokenOutput();
          // `null` is a dev script that never exits and never answers — a server
          // being stopped before it was ready.
          if (devScript.code === null) return process();
          return simple(devScript.output, devScript.code);
        }
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

  const DEV_PLAN = (scripts: Record<string, string> = { dev: "vite" }) =>
    planMount({
      base: [
        { path: "package.json", content: JSON.stringify({ scripts }) },
        { path: "package-lock.json", content: "{}" },
      ],
      changes: [],
    });

  it("starts the declared script and reports where it answered", async () => {
    const processes: { killed: boolean }[] = [];
    bootWith(processes);

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
    bootWith(processes);

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

  it("gives the dev server up when another thread takes the workspace", async () => {
    // The preview is a server over ONE thread's tree. When a second thread takes
    // the filesystem the tree it is serving stops existing, and a preview that
    // keeps answering from a removed directory is worse than no preview: the user
    // would read a stale page as evidence about the newer agent's revision.
    const processes: { killed: boolean }[] = [];
    bootWith(processes);

    const started = await startPreview({
      plan: DEV_PLAN(),
      revision: 1,
      owner: { threadId: "alice", label: "fix the parser" },
    });
    expect(started.ok).toBe(true);
    expect(processes[0]?.killed).toBe(false);

    // Thread B runs a command: same page, one filesystem, so the claim empties
    // alice's tree and she loses the workspace.
    const bob = await runInContainer({
      command: "npm test",
      plan: DEV_PLAN(),
      revision: 2,
      owner: { threadId: "bob", label: "add a test" },
    });
    expect(bob.ok).toBe(true);

    expect(processes[0]?.killed).toBe(true);
    expect(previewState().status).toBe("stopped");
    expect(previewState().url).toBeNull();
    expect(previewState().notes.join(" ")).toMatch(/dev server was stopped because/);
  });

  it("reports the exit status and the printed cause when the dev script dies", async () => {
    bootWithDevScript({
      output: "You are using Node.js v20.11.0. Vite requires Node.js version 20.19+ or 22.12+.\n",
      code: 1,
    });

    const outcome = await startPreview({ plan: DEV_PLAN(), revision: 1 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the start to fail");
    // The status is the whole difference between a script that refused to run and
    // one that simply finished; the old message carried neither it nor the cause.
    expect(outcome.error).toBe("`npm run dev` exited before it served anything (exit status 1)");
    const notes = previewState().notes.join("\n");
    expect(notes).toContain("refuses the workspace's Node.js version");
    expect(notes).toContain("You are using Node.js v20.11.0");
    expect(previewState().status).toBe("failed");
  });

  it("distinguishes a script that finished from one that refused to run", async () => {
    bootWithDevScript({ output: "build complete\n", code: 0 });

    const outcome = await startPreview({
      plan: DEV_PLAN({ dev: "vite", build: "vite build" }),
      revision: 1,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected the start to fail");
    expect(outcome.error).toBe("`npm run dev` ran and finished without starting a server");
    const notes = previewState().notes.join("\n");
    expect(notes).toContain("finished instead of staying up");
    expect(notes).toContain("also declares `build`");
  });

  it("says the output could not be read instead of implying the command was silent", async () => {
    bootWithDevScript({ output: "", code: 1, broken: true });

    await startPreview({ plan: DEV_PLAN(), revision: 1 });

    expect(previewState().notes.join("\n")).toContain("could not be read (the stream is gone)");
  });

  it("does not blame the project for a stop that landed while it was starting", async () => {
    bootWithDevScript({ output: "", code: null });

    const starting = startPreview({ plan: DEV_PLAN(), revision: 1 });
    await until(() => previewState().status === "starting");
    stopPreview("stopped by the test");

    expect(await starting).toEqual({
      ok: false,
      error: "the preview was stopped while it was starting",
    });
    expect(previewState().status).toBe("stopped");
    expect(previewState().notes.join(" ")).not.toMatch(/exited before it served/);
  });

  it("reaches the running server on stop, and leaves the workspace alone", async () => {
    const processes: { killed: boolean }[] = [];
    bootWith(processes);

    await startPreview({ plan: DEV_PLAN(), revision: 1 });
    stopPreview("stopped by the test");

    expect(processes[0]?.killed).toBe(true);
    expect(previewState().status).toBe("stopped");
    expect(previewState().url).toBeNull();
  });
});

describe("a failed preview explains itself", () => {
  it("keeps the exit status, which separates two unrelated situations", () => {
    expect(describeDevServerExit(0)).toBe("ran and finished without starting a server");
    expect(describeDevServerExit(1)).toBe("exited before it served anything (exit status 1)");
    expect(describeDevServerExit(null)).toBe("exited before it served anything");
  });

  it("names the runtime limit behind a Node version refusal", () => {
    const hint = diagnoseDevServerFailure("Vite requires Node.js version 20.19+", 1);
    expect(hint).toContain("Node.js version");
    expect(hint).toContain("limit of the preview");
  });

  it("names native addons, occupied ports and missing binaries", () => {
    expect(diagnoseDevServerFailure("Cannot load native addon", 1)).toMatch(/native addons/);
    expect(diagnoseDevServerFailure("listen EADDRINUSE: address already in use", 1)).toMatch(
      /already listening/
    );
    expect(diagnoseDevServerFailure("sh: vite: not found", 1)).toMatch(/missing from the workspace/);
  });

  it("invents no cause when the output names none", () => {
    // A wrong cause is worse than no cause: it sends the reader to fix something
    // that is not broken.
    expect(diagnoseDevServerFailure("TypeError: cannot read properties of undefined", 1)).toBeNull();
    expect(diagnoseDevServerFailure("", 1)).toBeNull();
  });

  it("tells a finished script which other script might be the server", () => {
    const hint = diagnoseDevServerFailure("done", 0, ["build", "start"]);
    expect(hint).toContain("finished instead of staying up");
    expect(hint).toContain("`build`");
    expect(hint).toContain("`start`");
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
