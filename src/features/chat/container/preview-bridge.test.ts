import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/** The fake IndexedDB, so persistence can be inspected without a browser */
const previewIdb = new Map<string, string>();
vi.mock("@/services/idb-storage.service", () => ({
  readValue: vi.fn(async (key: string) => previewIdb.get(key) ?? null),
  writeValue: vi.fn(async (key: string, value: string | null) => {
    if (value === null) previewIdb.delete(key);
    else previewIdb.set(key, value);
  }),
}));
import type { FileSystemTree } from "@webcontainer/api";
import {
  MAX_PREVIEW_ISSUES,
  PREVIEW_INVARIANT_RETRY_DELAY_MS,
  PREVIEW_POST_READY_DRAIN_MS,
  PREVIEW_RENDER_SMOKE_DELAY_MS,
  describeDevServerExit,
  detectDevServer,
  diagnoseDevServerFailure,
  livePreviewRepoKey,
  livePreviewState,
  notePreviewMessageForTest,
  packageJsonOf,
  previewScriptInstalledForTest,
  previewEvidenceNote,
  previewState,
  repoKeyOf,
  resetPreview,
  setPreviewView,
  startPreview,
  stopPreview,
  waitForPreviewSettle,
  setStateForTest,
} from "./preview-bridge";
import { handleControlReply, setPreviewFrameWindowForTest } from "./preview-control-bridge";
import { planMount } from "./mount-plan";
import { resetContainerHost, setContainerModuleLoader, type ContainerRuntime } from "./container-host";
import { resetContainerQueue, runInContainer } from "./container-executor";
import { resetRuntimeEnvForTest, setRepoEnvVar } from "./runtime-env";

const globals = globalThis as unknown as Record<string, unknown>;
let isolated: unknown;
let secure: unknown;

const PKG = JSON.stringify({
  name: "demo",
  scripts: { build: "vite build", test: "vitest run" },
});

/**
 * A preview frame that answers a get-tree the way the injected bootstrap does:
 * the reply arrives through the control bridge's exported pairing handler,
 * because a node test has no MessageEvent to dispatch.
 */
function fakePreviewWindow(result: Record<string, unknown>): { posted: unknown[] } {
  const win = {
    posted: [] as unknown[],
    postMessage(message: unknown, _origin: string): void {
      win.posted.push(message);
      const request = message as { channel?: string; id?: string };
      if (request.channel !== "intab-preview-control") return;
      setTimeout(() => {
        handleControlReply({
          channel: "intab-preview-control-result",
          id: request.id,
          result,
        });
      }, 5);
    },
  };
  return win;
}

/** Waits for a condition the module satisfies on a later turn of the loop */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the condition never became true");
}

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
 * A runtime from BEFORE `setPreviewScript` existed: the API rejects, so neither
 * bootstrap carrier is present (no mount-time injection for a generated page,
 * no runtime-level injection) — the shape the probe's gate must skip silently.
 */
function bootWithLegacyRuntime(devProcesses: { killed: boolean }[]): void {
  const runtime = devRuntime(devProcesses) as unknown as Record<string, unknown>;
  runtime.setPreviewScript = vi.fn(async () => {
    throw new Error("setPreviewScript is not a function");
  });
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
function bootWithDevScript(
  devScript: { output: string; code: number | null; broken?: boolean },
  devProcesses: { killed: boolean }[] = []
): void {
  const runtime = devRuntime(devProcesses, devScript);
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
    setPreviewScript: vi.fn(async () => {}),
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

describe("repoKeyOf — the identity a session is filed under", () => {
  it("joins owner and repo", () => {
    expect(repoKeyOf("acme", "widgets")).toBe("acme/widgets");
  });

  it("is null without a repository — a preview belongs to a repo or nothing", () => {
    expect(repoKeyOf("acme", "")).toBeNull();
    expect(repoKeyOf(null, "widgets")).toBeNull();
    expect(repoKeyOf("", null)).toBeNull();
  });

  it("trims sloppy input rather than filing two keys for one repo", () => {
    expect(repoKeyOf(" acme ", " widgets ")).toBe("acme/widgets");
  });
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
    resetRuntimeEnvForTest();
  });

  afterEach(() => {
    globals.crossOriginIsolated = isolated;
    globals.isSecureContext = secure;
    setContainerModuleLoader(() => import("@webcontainer/api"));
    resetPreview();
    resetContainerHost();
    resetContainerQueue();
    resetRuntimeEnvForTest();
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

    describe("preview sessions — one record per repository", () => {
    it("files a started session under its repo, and the view follows it", async () => {
      bootWith([]);
      const started = await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
      expect(started.ok).toBe(true);
      expect(livePreviewRepoKey()).toBe("acme/alpha");
      expect(previewState().status).toBe("running");
    });

    it("keeps each repo's failed start out of the other repo's record", async () => {
      // Repo A's dev script fails; the user switches to repo B. B's record must
      // read idle — A's failure belongs to A, and showing it to B is how a user
      // ends up convinced the wrong project is broken.
      bootWith([]);
      await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
      setStateForTest({ status: "failed", notes: ["EADDRINUSE"] });
      setPreviewView("acme/beta");
      expect(previewState().status).toBe("idle");
      expect(previewState().notes).toEqual([]);
      // …and A's failure is still there when they come back.
      setPreviewView("acme/alpha");
      expect(previewState().status).toBe("failed");
      expect(previewState().notes).toContain("EADDRINUSE");
    });

    it("does not overwrite another repo's record when a takeover stops the old server", async () => {
    // The takeover's terminal "stopped" is ABOUT repo A's server; with liveKey
    // already re-pointed at B when the kill lands, the naive setState filed it
    // under B — and A read as "stopped" though nothing had touched it.
    const processes: { killed: boolean }[] = [];
    bootWith(processes);
    await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    // Switch the view away first, so the takeover happens while alpha's record
    // is only in the map, not on screen.
    setPreviewView("acme/beta");
    await startPreview({ plan: DEV_PLAN(), revision: 2, repoKey: "acme/beta" });
    setPreviewView("acme/alpha");
    expect(previewState().status).toBe("stopped");
    setPreviewView("acme/beta");
    expect(previewState().status).toBe("running");
  });

  it("keeps the live session alive while the view is elsewhere", async () => {
      // Switching repos looks at another record; it does not kill the server.
      const processes: { killed: boolean }[] = [];
      bootWith(processes);
      await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
      setPreviewView("acme/beta");
      expect(processes[0]?.killed ?? false).toBe(false);
      expect(livePreviewState().status).toBe("running");
      expect(livePreviewRepoKey()).toBe("acme/alpha");
      // Back to the live repo: its running state is exactly as it was.
      setPreviewView("acme/alpha");
      expect(previewState().status).toBe("running");
      expect(previewState().url).toBe("http://localhost:3000/");
    });

    it("routes a stop to the live repo's record, not to the viewed one", async () => {
      bootWith([]);
      await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
      setPreviewView("acme/beta");
      stopPreview("stopped by the user");
      setPreviewView("acme/alpha");
      expect(previewState().status).toBe("stopped");
      expect(previewState().notes).toContain("stopped by the user");
      expect(livePreviewRepoKey()).toBeNull();
    });

  it("files console errors under the repo that was live when they arrived", () => {
    bootWith([]);
    void startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "boom in alpha" });
    setPreviewView("acme/beta");
    // The only server on the page still belongs to alpha, so its console is
    // alpha's evidence even while the user is looking at beta's record.
    notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "another alpha line" });
    setPreviewView("acme/alpha");
    const messages = previewState().issues.map((issue) => issue.message);
    expect(messages).toContain("boom in alpha");
    expect(messages).toContain("another alpha line");
  });

    it("gives the evidence note the live server, not the viewed record", async () => {
      bootWith([]);
      await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
      notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "alpha exploded" });
      setPreviewView("acme/beta");
      // Repo B is on screen and has no issues; the note must still describe the
      // LIVE app, because the agent's next turn is about the running server.
      expect(previewEvidenceNote()).toContain("alpha exploded");
    });
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

  it("does not blame the project when no package.json reached the workspace", async () => {
    // An over-budget mount can leave the manifest unfetched. That is this
    // workspace's omission, and the old note read it as the project's
    // declaration — "declares no dev/start/serve/preview script" — sending the
    // user to fix scripts that exist and were never mounted.
    bootWith([]);
    const plan = planMount({
      base: [{ path: "src/index.ts", content: "export const a = 1;" }],
      changes: [],
    });
    const started = await startPreview({ plan, revision: 1 });
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("expected the start to fail");
    expect(started.error).toMatch(/No package\.json reached the workspace/);
    expect(previewState().notes.join(" ")).toContain("the mount dropped it");
  });

  it("names a blank page instead of reporting a healthy server over an empty root", async () => {
    // The third screenshot's shape: the server answers, the status reads
    // "running", and nothing rendered below the header. The old surface said
    // nothing about that — the smoke probe makes the symptom named evidence.
    // The plan carries an index.html, so the mount injects the bootstrap and
    // the probe runs.
    bootWith([]);
    const plan = planMount({
      base: [
        { path: "package.json", content: JSON.stringify({ scripts: { dev: "vite" } }) },
        { path: "package-lock.json", content: "{}" },
        { path: "index.html", content: "<!doctype html><html><head></head><body><div id=\"app\"></div></body></html>" },
      ],
      changes: [],
    });
    const win = fakePreviewWindow({ ok: true, snapshot: { nodes: [], totalNodes: 0, truncated: false, title: "V17", url: "http://localhost:3000/" } });
    setPreviewFrameWindowForTest(win as unknown as Window);
    try {
      await startPreview({ plan, revision: 1 });
      await vi.waitFor(
        async () => {
          const kinds = previewState().issues.map((issue) => issue.kind);
          expect(kinds).toContain("blank-page");
        },
        { timeout: 8000 }
      );
      const blank = previewState().issues.find((issue) => issue.kind === "blank-page");
      expect(blank?.message).toContain("rendered nothing");
      expect(previewState().status).toBe("running");
    } finally {
      setPreviewFrameWindowForTest(null);
    }
  }, 10_000);

  it("stays silent when the page rendered content", async () => {
    bootWith([]);
    const plan = planMount({
      base: [
        { path: "package.json", content: JSON.stringify({ scripts: { dev: "vite" } }) },
        { path: "package-lock.json", content: "{}" },
        { path: "index.html", content: "<!doctype html><html><head></head><body><div id=\"app\"></div></body></html>" },
      ],
      changes: [],
    });
    const win = fakePreviewWindow({
      ok: true,
      snapshot: {
        nodes: [{ uid: null, kind: "heading", label: "Mammas Recept", depth: 1 }],
        totalNodes: 1,
        truncated: false,
        title: "V17",
        url: "http://localhost:3000/",
      },
    });
    setPreviewFrameWindowForTest(win as unknown as Window);
    try {
      await startPreview({ plan, revision: 1 });
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_RENDER_SMOKE_DELAY_MS + 1200));
      expect(previewState().issues.map((issue) => issue.kind)).not.toContain("blank-page");
      expect(previewState().status).toBe("running");
    } finally {
      setPreviewFrameWindowForTest(null);
    }
  }, 10_000);

  it("does not send the render probe at a page that carries no bootstrap", async () => {
    // The screenshot's first lie: a Next.js dev server serves a GENERATED
    // document, so the mount had no index.html to inject into — the probe can
    // never be answered, yet its timeout issue told the user the page was
    // "wedged" and to reload a fix that could never work. No bootstrap, no probe.
    bootWithLegacyRuntime([]);
    const plan = planMount({
      base: [
        { path: "package.json", content: JSON.stringify({ scripts: { dev: "next dev" } }) },
        { path: "package-lock.json", content: "{}" },
        { path: "app/page.tsx", content: "export default function Page() { return null; }" },
      ],
      changes: [],
    });
    const win = fakePreviewWindow({ ok: true, snapshot: { nodes: [], totalNodes: 0, truncated: false, title: "x", url: "http://localhost:3000/" } });
    setPreviewFrameWindowForTest(win as unknown as Window);
    try {
      await startPreview({ plan, revision: 1 });
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_RENDER_SMOKE_DELAY_MS + 400));
      expect(previewState().issues.map((issue) => issue.kind)).not.toContain("blank-page");
      expect(previewState().status).toBe("running");
      // The probe never asked: an injected page would have been sent a get-tree.
      expect(win.posted).toHaveLength(0);
    } finally {
      setPreviewFrameWindowForTest(null);
    }
  }, 10_000);

  it("keeps the project's own answer when the manifest is mounted but lists no dev script", async () => {
    bootWith([]);
    const plan = planMount({
      base: [{ path: "package.json", content: JSON.stringify({ scripts: { build: "next build" } }) }],
      changes: [],
    });
    const started = await startPreview({ plan, revision: 1 });
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("expected the start to fail");
    expect(started.error).toContain("declares no dev/start/serve/preview script");
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
    // The stop arrives BEFORE the process exists to kill: the mount and the
    // install are still running, `stopPreview` therefore killed nothing, and the
    // server this attempt then spawned is one the user has already stopped.
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

  it("does not wait out the timeout for a start that was stopped while serving", async () => {
    // The other half of the same window, one step later: the process exists, so
    // the stop reaches it — but a wait for a server that never answers must not
    // run to its two-minute timeout when the answer is already known, and the
    // caller must not be handed a failure the project did not cause.
    const processes: { killed: boolean }[] = [];
    bootWithDevScript({ output: "", code: null }, processes);

    const starting = startPreview({ plan: DEV_PLAN(), revision: 1 });
    await until(() => processes.length === 1);
    stopPreview("stopped by the test");

    expect(await starting).toEqual({
      ok: false,
      error: "the preview was stopped while it was starting",
    });
    expect(processes[0]?.killed).toBe(true);
    expect(previewState().status).toBe("stopped");
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

  it("starts the dev server with the repo's runtime env — the spawn that bakes VITE_* into the app", async () => {
    // The Supabase case that motivated the runtime-env layer: `npm run dev`
    // reads `VITE_*` at startup and inlines the values, so a key stored once
    // reaches the RUNNING SITE through this spawn alone. No file is mounted,
    // nothing is written into the repo.
    await setRepoEnvVar("acme", "alpha", "VITE_SUPABASE_URL", "https://x.supabase.co");
    await setRepoEnvVar("acme", "alpha", "VITE_SUPABASE_ANON_KEY", "eyJhbGciOi");
    const processes: { killed: boolean }[] = [];
    bootWith(processes);
    // Wrap the fake runtime's spawn so each call's env option is recorded — a
    // plain closure, because the merge is the fact under test, not the mock.
    const runtime = devRuntime(processes);
    const innerSpawn = runtime.spawn.bind(runtime);
    const spawnedCalls: unknown[][] = [];
    runtime.spawn = (async (...args: Parameters<ContainerRuntime["spawn"]>) => {
      spawnedCalls.push(args as unknown[]);
      return innerSpawn(...args);
    }) as ContainerRuntime["spawn"];
    setContainerModuleLoader(
      async () => ({ WebContainer: { boot: vi.fn(async () => runtime) } }) as unknown as typeof import("@webcontainer/api")
    );

    const started = await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    expect(started.ok).toBe(true);

    // The dev server's own call is the one whose command line names the script;
    // the earlier ones are the node-version probe and the install.
    const devCall = spawnedCalls.find((call) => (call[1] as string[]).join(" ").includes("npm run dev"));
    expect(devCall).toBeDefined();
    const env = (devCall?.[2] as { env?: Record<string, string> } | undefined)?.env ?? {};
    expect(env.VITE_SUPABASE_URL).toBe("https://x.supabase.co");
    expect(env.VITE_SUPABASE_ANON_KEY).toBe("eyJhbGciOi");
    // The preview's base env survives the merge.
    expect(env.BROWSER).toBe("none");
    expect(env.CI).toBe("1");
  });

  it("reports a server that dies AFTER answering, instead of staying green over a dead port", async () => {
    // The screenshot's real failure: a Next.js dev server binds its port,
    // answers `server-ready`, and dies on the first request (a binding this
    // runtime cannot load). The watcher only covered the path TO ready, so the
    // strip read "running" while the frame said "Unable to connect".
    const processes: { killed: boolean }[] = [];
    let serverReady: ((port: number, url: string) => void) | null = null;
    const oneShot = (out: string, code: number) => {
      let resolveExit: (value: number) => void = () => {};
      const exit = new Promise<number>((resolve) => {
        resolveExit = resolve;
        setTimeout(() => resolve(code), 0);
      });
      return {
        exit,
        output: new ReadableStream<string>({ start: (c) => { c.enqueue(out); c.close(); } }),
        kill: () => resolveExit(137),
      };
    };
    const runtime = {
      mount: vi.fn(async () => {}),
      fs: { writeFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}), rm: vi.fn(async () => {}) },
      spawn: vi.fn(async (command: string, args: string[]) => {
        const line = `${command} ${args.join(" ")}`;
        if (line.includes("node --version")) return oneShot("v22.0.0\n", 0);
        if (line.includes("npm ci")) return oneShot("added 1 package\n", 0);
        // The dev server: answers `server-ready`, then dies on its first
        // request — the exact order the screenshot's crash produced.
        const record = { killed: false };
        processes.push(record);
        let resolveExit: (code: number) => void = () => {};
        const exit = new Promise<number>((resolve) => {
          resolveExit = resolve;
        });
        setTimeout(() => serverReady?.(3111, "http://localhost:3111/"), 0);
        setTimeout(() => resolveExit(1), 25);
        return {
          exit,
          output: new ReadableStream<string>({ start: (c) => { c.enqueue("Error: Cannot load native binding\n"); c.close(); } }),
          kill: () => {
            record.killed = true;
            resolveExit(137);
          },
        };
      }),
      on: vi.fn((event: string, listener: (port: number, url: string) => void) => {
        if (event === "server-ready") serverReady = listener;
        return () => {};
      }),
      teardown: vi.fn(async () => {}),
    } as unknown as ContainerRuntime;
    setContainerModuleLoader(
      async () => ({ WebContainer: { boot: vi.fn(async () => runtime) } }) as unknown as typeof import("@webcontainer/api")
    );

    await startPreview({ plan: DEV_PLAN(), revision: 1 });
    expect(previewState().status).toBe("running");

    // The drain wait is part of the report, so poll past it.
    await vi.waitFor(async () => {
      expect(previewState().status).toBe("failed");
    }, { timeout: 5000 });
    const notes = previewState().notes.join("\n");
    expect(notes).toContain("died after it started serving");
    expect(notes).toContain("exit status 1");
    // The server's own last words ride the report, and the named cause is the
    // one the FAILURE_HINTS table already knows.
    expect(notes).toContain("Cannot load native binding");
    expect(notes).toMatch(/native addons|compiled binding/);
    expect(previewState().url).toBeNull();
    expect(previewState().port).toBeNull();
    // The evidence note reads as what happened — died, not never-started.
    expect(previewEvidenceNote()).toContain("dev server started and then died");
  }, 10_000);

  it("does not report a deliberate stop as a post-ready crash", async () => {
    const processes: { killed: boolean }[] = [];
    bootWith(processes);

    await startPreview({ plan: DEV_PLAN(), revision: 1 });
    stopPreview("stopped by the test");
    // The kill resolves the exit promise; the watcher fires, but the token has
    // moved — the record stays what the stop made it.
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_POST_READY_DRAIN_MS + 300));
    expect(previewState().status).toBe("stopped");
    expect(previewState().notes).toContain("stopped by the test");
  });

  it("restarts the dev server ONCE when the workStore invariant arrives on a live preview", async () => {
    // The invariant is a request-context race inside Next's own render, not a
    // code error — the retry a user would reach for is the harness's to take.
    // Capped at one per page: a second invariant is a pattern restarting cannot
    // fix, and an automatic loop would hide it.
    const processes: { killed: boolean }[] = [];
    bootWith(processes);
    const started = await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    expect(started.ok).toBe(true);
    const firstProcess = processes[0];

    previewScriptInstalledForTest(true);
    notePreviewMessageForTest({
      type: "PREVIEW_UNCAUGHT_EXCEPTION",
      message: "Invariant: Expected workStore to be initialized. This is a bug in Next.js.",
    });
    // The restart is delayed so an exit-driven failure report can land first.
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_INVARIANT_RETRY_DELAY_MS + 150));

    expect(firstProcess?.killed).toBe(true);
    expect(processes.length).toBe(2);
    // The restarted server answers server-ready on a later turn of the loop,
    // and the restart's own mount+install cycle runs first — worth a real wait.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(previewState().status).toBe("running");
    expect(previewState().notes.join(" ")).toContain("restarted once");
    // The probe gate is one-shot: consumed by the restart's own smoke check
    // (with the fake's 4s render delay this just proves it did not stick).
    previewScriptInstalledForTest(false);
  });

  it("does not loop: the second invariant is recorded, not restarted", async () => {
    const processes: { killed: boolean }[] = [];
    bootWith(processes);
    await startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });

    previewScriptInstalledForTest(true);
    notePreviewMessageForTest({
      type: "PREVIEW_UNCAUGHT_EXCEPTION",
      message: "Invariant: Expected workStore to be initialized. This is a bug in Next.js.",
    });
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_INVARIANT_RETRY_DELAY_MS + 150));
    expect(processes.length).toBe(2);

    notePreviewMessageForTest({
      type: "PREVIEW_UNCAUGHT_EXCEPTION",
      message: "Invariant: Expected workStore to be initialized. This is a bug in Next.js.",
    });
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_INVARIANT_RETRY_DELAY_MS + 150));
    expect(processes.length).toBe(2); // unchanged — the cap held
    expect(previewState().status).toBe("running");
    previewScriptInstalledForTest(false);
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
    // The same limit wearing a different error, and the one a Vite 8 project hits:
    // a napi-rs loader's WASM binding loads and then refuses. Reported with the
    // same cause, because it is one — the process never reached the project's code.
    expect(
      diagnoseDevServerFailure("Error: `__napiBindingTarget` is reserved by the generated binding loader", 1)
    ).toMatch(/compiled binding/);
    expect(diagnoseDevServerFailure("listen EADDRINUSE: address already in use", 1)).toMatch(
      /already listening/
    );
    expect(diagnoseDevServerFailure("sh: vite: not found", 1)).toMatch(/missing from the workspace/);
  });

  it("names a CJS global in an ESM package's config — the __dirname-after-Ready death", () => {
    // The sulkasnickeri failure, verbatim: the server printed Ready, answered
    // server-ready, and died on the first request when Next compiled
    // next.config.ts into an ES module ("type": "module" package) and the
    // config read __dirname. Without this hint the output is a bare
    // ReferenceError, and nothing in it says the fix is one line in the repo.
    const hint = diagnoseDevServerFailure(
      "ReferenceError: __dirname is not defined in ES module scope\n    at eval (file:///home/x/next.config.compiled.js:47:15)",
      1
    );
    expect(hint).toContain("ES module");
    expect(hint).toContain("import.meta.dirname");
  });

  it("invents no cause when the output names none", () => {
    // A wrong cause is worse than no cause: it sends the reader to fix something
    // that is not broken.
    expect(diagnoseDevServerFailure("TypeError: cannot read properties of undefined", 1)).toBeNull();
    expect(diagnoseDevServerFailure("", 1)).toBeNull();
  });

  it("decorates the Next.js workStore invariant with the runtime limitation and a retry", () => {
    // Forwarded from a LIVE frame as a console/uncaught issue (the process is
    // still answering — diagnoseDevServerFailure never runs), so the hint has
    // to ride the issue layer. The message must name the upstream issue and
    // say the failure is timing-shaped, or the reader debugs their own code
    // for what is a runtime limitation.
    notePreviewMessageForTest({
      type: "PREVIEW_UNCAUGHT_EXCEPTION",
      message: "Invariant: Expected workStore to be initialized. This is a bug in Next.js.",
    });
    const issue = previewState().issues[previewState().issues.length - 1];
    expect(issue?.message).toContain("15.4");
    expect(issue?.message).toContain("Retry the preview");
  });

  it("sends Turbopack-in-WASM to the documented --webpack opt-out", () => {
    // Next 16 defaults `next dev` to Turbopack, whose bindings cannot run on
    // WASM (vercel/next.js#75665) — the exact wall the sulkasnickeri preview
    // hit after its config-import fix. The hint names the opt-out instead of
    // leaving the reader debugging an engine that was never going to start.
    const hint = diagnoseDevServerFailure(
      "Error: `turbo.createProject` is not supported by the current WebAssembly bindings",
      1
    );
    expect(hint).toContain("--webpack");
    expect(hint).toMatch(/Turbopack/);
  });

  it("sends a relative-path module miss to the project, not the install", () => {
    // The second wrong answer the live preview produced: `Cannot find module
    // '/home/<workspace>/lib/sanity/require-project'` was diagnosed as an
    // install problem, sending the reader to re-run an install that was never
    // the cause. A path that does not name a package is the project's own file.
    const projectImport = diagnoseDevServerFailure(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/k03e2io1v3fx9wvj0vr8qd5q58o56n-fkdo/lib/sanity/require-project' imported from '/home/k03e2io1v3fx9wvj0vr8qd5q58o56n-fkdo/next.config.compiled.js'",
      1
    );
    expect(projectImport).toContain("project import");
    expect(projectImport).toContain("next.config.compiled.js");
    // A package specifier stays the install's problem — the generic hint.
    expect(
      diagnoseDevServerFailure("Error: Cannot find module 'react-server-dom-webpack/client'", 1)
    ).toMatch(/missing from the workspace/);
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

describe("waitForPreviewSettle — the read-after-edit boundary", () => {
  beforeEach(() => resetPreview());

  it("resolves immediately when running and already quiet", async () => {
    const pending = waitForPreviewSettle({ quietMs: 30, timeoutMs: 500 });
    await until(() => true);
    expect(await pending).toBeUndefined();
  });

  it("settles early on a failed preview instead of waiting out the quiet window", async () => {
    const pending = waitForPreviewSettle({ quietMs: 10_000, timeoutMs: 10_000 });
    // A failed STATUS (not merely an issue) is what ends the wait early.
    // The test seam moves the state directly; startPreview's failure path
    // needs a real container, which is covered by the suites above.
    const startedAt = Date.now();
    setStateForTest({ status: "failed" });
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(9_000);
  });

  it("stays pending while the preview has not started, until the timeout", async () => {
    const pending = waitForPreviewSettle({ quietMs: 5, timeoutMs: 80 });
    await pending;
    // Returning at all is the assertion: an `idle` preview never arms the
    // quiet window, so the deadline is the only way out.
    expect(previewState().status).toBe("idle");
  });

  it("ends the wait when a running preview goes quiet", async () => {
    const pending = waitForPreviewSettle({ quietMs: 40, timeoutMs: 2_000 });
    setStateForTest({ status: "running", url: "http://localhost:5173" });
    await pending;
    expect(previewState().status).toBe("running");
  });
});

// ============================================================
// Reload survival — the record outlives the page
// ============================================================
// The dev server dies with the page; the record must not. These tests write a
// session, reload the MODULE (a fresh import is what a page reload actually
// is), and assert what the fresh module knows.

describe("preview records — persistence and restore across a reload", () => {
  beforeEach(() => {
    isolated = globals.crossOriginIsolated;
    secure = globals.isSecureContext;
    globals.crossOriginIsolated = true;
    globals.isSecureContext = true;
    previewIdb.clear();
    vi.resetModules();
    resetPreview();
    resetContainerHost();
    resetContainerQueue();
  });

  afterEach(() => {
    globals.crossOriginIsolated = isolated;
    globals.isSecureContext = secure;
    setContainerModuleLoader(() => import("@webcontainer/api"));
    previewIdb.clear();
    vi.resetModules();
    resetPreview();
    resetContainerHost();
    resetContainerQueue();
  });

  /**
   * A fresh module — what a page load actually is.
   *
   * The fake runtime is installed on the FRESH graph's container-host: after
   * `vi.resetModules()` the statically-imported host is a different module
   * instance than the one the fresh bridge bootstraps, and only the boot path
   * subscribes `server-ready`. Installing once on the stale host and wondering
   * why the reloaded module cannot start a server is how this suite would test
   * the wrong thing.
   */
  async function freshBridge(opts: { fake?: boolean } = {}) {
    if (opts.fake !== false) await bootFreshWith([]);
    return import("./preview-bridge");
  }

  /** Installs the fake runtime on the CURRENT module graph's container-host */
  async function bootFreshWith(
    devProcesses: { killed: boolean }[],
    devScript?: { output: string; code: number | null; broken?: boolean }
  ) {
    const host = await import("./container-host");
    host.resetContainerHost();
    const runtime = devRuntime(devProcesses, devScript);
    const boot = vi.fn(async () => runtime);
    host.setContainerModuleLoader(
      async () => ({ WebContainer: { boot } }) as unknown as typeof import("@webcontainer/api")
    );
    return host;
  }

  it("persists a running session, and a fresh module restores it as stopped with the record intact", async () => {
    await bootFreshWith([]);
    const mod = await import("./preview-bridge");
    await mod.startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    mod.notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "boom" });
    await mod.persistPreviewRecords();

    // ── reload ──
    vi.resetModules();
    resetPreview();
    const next = await freshBridge();
    await next.previewRecordsRestored();

    // The live record survives the reload as the repo's record — degraded to
    // "stopped" (the server died with the page), never "running".
    expect(next.previewState().status).toBe("stopped");
    expect(next.previewState().command).toBe("npm run dev");
    expect(next.previewState().issues.map((i) => i.message)).toContain("boom");
    expect(next.previewState().notes.join("\n")).toContain("page was reloaded");
    expect(next.livePreviewRepoKey()).toBe("acme/alpha");
    // The restored live session is a pending auto-restart, claimed exactly once.
    expect(next.reloadEndedPreviewRepo()).toBe("acme/alpha");
    expect(next.claimReloadEndedPreview("acme/alpha")).toBe(true);
    expect(next.reloadEndedPreviewRepo()).toBeNull();
    expect(next.claimReloadEndedPreview("acme/alpha")).toBe(false);
  });

  it("keeps archived records and the viewed repo across the reload, without offering a restart for them", async () => {
    await bootFreshWith([]);
    const mod = await import("./preview-bridge");
    await mod.startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    mod.setPreviewView("acme/beta");
    await mod.persistPreviewRecords();

    vi.resetModules();
    resetPreview();
    const next = await freshBridge();
    await next.previewRecordsRestored();

    // The view lands back on the repo the user was LOOKING at, and alpha's
    // record was archived, not lost — degraded to "stopped", since its server
    // died with the page exactly as the live record's did.
    expect(next.previewState().status).toBe("stopped");
    next.setPreviewView("acme/alpha");
    expect(next.previewState().status).toBe("stopped");
    expect(next.previewState().command).toBe("npm run dev");
    expect(next.livePreviewRepoKey()).toBe("acme/alpha");
    // Only the LIVE session restarts — beta was never running anywhere.
    expect(next.reloadEndedPreviewRepo()).toBe("acme/alpha");
  });

  it("degrades a live record's url and port — no page may claim a dead origin", async () => {
    await bootFreshWith([]);
    const mod = await import("./preview-bridge");
    await mod.startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    await mod.persistPreviewRecords();

    vi.resetModules();
    resetPreview();
    const next = await freshBridge();
    await next.previewRecordsRestored();
    expect(next.previewState().url).toBeNull();
    expect(next.previewState().port).toBeNull();
    expect(next.previewState().startedAt).toBeNull();
  });

  it("survives a malformed record: garbage in the store is a missing backup, not a broken module", async () => {
    previewIdb.set("intab_preview_sessions", "{not json");
    const next = await freshBridge();
    await next.previewRecordsRestored();
    expect(next.previewState().status).toBe("idle");
    expect(next.livePreviewRepoKey()).toBeNull();
  });

  it("restores a failed record with its diagnosis, as a failure — the one status that can still be true", async () => {
    await bootFreshWith([], { output: "EADDRINUSE", code: 1 });
    const mod = await import("./preview-bridge");
    await mod.startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    expect(mod.livePreviewState().status).toBe("failed");
    await mod.persistPreviewRecords();

    vi.resetModules();
    resetPreview();
    const next = await freshBridge();
    await next.previewRecordsRestored();
    expect(next.previewState().status).toBe("failed");
    expect(next.previewState().notes.join("\n")).toContain("EADDRINUSE");
    // A failure needs no restart — the record IS the answer.
    expect(next.reloadEndedPreviewRepo()).toBeNull();
  });

  it("the reloader's first view switch does not clobber the restored record with a placeholder", async () => {
    // THE regression that made reloads feel broken: the page's ChatPage points
    // the view at the active repo on mount, and the old archive step wrote the
    // module's placeholder INITIAL state over the record the previous page had
    // left — the user read "idle" over their console history, and the panel's
    // age reset. Restored records are the current truth on a page that has
    // started nothing; there is nothing to archive over them.
    await bootFreshWith([]);
    const mod = await import("./preview-bridge");
    await mod.startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    mod.notePreviewMessageForTest({ type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "boom in alpha" });
    await mod.persistPreviewRecords();

    vi.resetModules();
    resetPreview();
    const next = await freshBridge();
    await next.previewRecordsRestored();
    // Exactly the sequence ChatPage runs on a restored page: the view is set
    // to the active repo (already the view), then away, then back.
    next.setPreviewView("acme/alpha");
    next.setPreviewView("acme/beta");
    next.setPreviewView("acme/alpha");

    expect(next.previewState().status).toBe("stopped");
    expect(next.previewState().command).toBe("npm run dev");
    expect(next.previewState().issues.map((i) => i.message)).toContain("boom in alpha");
    expect(next.previewState().notes.join("\n")).toContain("page was reloaded");
  });

  it("the claim survives the placeholder window: nothing consumes it before the real start", async () => {
    await bootFreshWith([]);
    const mod = await import("./preview-bridge");
    await mod.startPreview({ plan: DEV_PLAN(), revision: 1, repoKey: "acme/alpha" });
    await mod.persistPreviewRecords();

    vi.resetModules();
    resetPreview();
    const next = await freshBridge();
    await next.previewRecordsRestored();
    // The view churn ChatPage runs on mount must not spend the one-shot claim:
    // the restart is the page's decision, made when a real conversation exists.
    next.setPreviewView("acme/alpha");
    next.setPreviewView("acme/beta");
    expect(next.claimReloadEndedPreview("acme/alpha")).toBe(true);
  });
});
