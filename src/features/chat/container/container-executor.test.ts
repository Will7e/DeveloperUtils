// ============================================================
// Container Executor — The Contract, Against A Fake Runtime
// ============================================================
// The runtime boundary is injected (the same discipline `turn-engine.ts` uses for
// its engine deps), so the parts that decide what a result MEANS can be tested
// without a browser: that a non-zero exit is a successful call carrying a failing
// outcome, that a failed install stops the run instead of producing a red result
// about the code, and that Stop reaches the process.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSystemTree } from "@webcontainer/api";
import {
  ensureDependencies,
  resetContainerQueue,
  runInContainer,
} from "./container-executor";
import { adoptRuntimeForTest, resetContainerHost, type ContainerRuntime } from "./container-host";
import { planMount } from "./mount-plan";

const PKG = JSON.stringify({ name: "demo", scripts: { test: "vitest run" } });

function plan(extra: { path: string; content: string }[] = []) {
  return planMount({
    base: [{ path: "package.json", content: PKG }, { path: "package-lock.json", content: "{}" }, ...extra],
    changes: [],
  });
}

/**
 * A process whose output is everything at once and whose exit code is what the
 * test says — and whose `kill` resolves the exit, which is how the real runtime
 * behaves when a timeout reaches it.
 */
function fakeProcess(output: string, exitCode: number) {
  let killed = false;
  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
    setTimeout(() => {
      if (!killed) resolve(exitCode);
    }, 0);
  });
  return {
    exit,
    output: () =>
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue(output);
          controller.close();
        },
      }),
    kill: () => {
      killed = true;
      resolveExit(137);
    },
  };
}

function runtimeWith(spawn: ContainerRuntime["spawn"]): ContainerRuntime {
  return {
    mount: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    spawn,
    on: vi.fn(() => () => {}),
    teardown: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  resetContainerQueue();
  resetContainerHost();
});

afterEach(() => {
  adoptRuntimeForTest(null);
  resetContainerHost();
  resetContainerQueue();
});

describe("runInContainer — installing before judging", () => {
  it("installs the revision's dependencies first, and says it did", async () => {
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      return fakeProcess(line.includes("npm ci") ? "added 12 packages" : "2 passed", 0);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    const result = await runInContainer({ command: "npm test", plan: plan(), revision: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const commands = spawn.mock.calls.map((call) => `${call[0]} ${(call[1] as string[]).join(" ")}`);
    // Install happens BEFORE the command, and through the lockfile-exact form:
    // `npm ci`, not `npm install`, because this revision has a lockfile.
    expect(commands[1]).toContain("npm ci --no-audit --no-fund");
    expect(commands[2]).toContain("npm test");
    expect(result.outcome.notes.join(" ")).toMatch(/ran in the browser workspace first/);
    expect(result.outcome.exitCode).toBe(0);
  });

  it("stops rather than reporting a red result when the install fails", async () => {
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm ci")) return fakeProcess("ERESOLVE could not resolve", 1);
      throw new Error("the command must never be spawned");
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    const result = await runInContainer({ command: "npm test", plan: plan(), revision: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The distinction that matters: a suite that could not be installed never ran,
    // so reporting it as a failing suite would be a lie about the change.
    expect(result.error).toMatch(/dependencies could not be installed/);
    expect(result.error).toMatch(/proves nothing either way/);
  });

  it("treats a non-zero exit as a result, not as a failure to run", async () => {
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm ci")) return fakeProcess("added 12 packages", 0);
      return fakeProcess("FAIL src/a.test.ts\n  expected 1 to be 2", 1);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    const result = await runInContainer({ command: "npm test", plan: plan(), revision: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.exitCode).toBe(1);
    expect(result.outcome.stdout).toContain("FAIL src/a.test.ts");
    // Merged by the runtime, and said so rather than pretended otherwise.
    expect(result.outcome.stderr).toBe("");
    expect(result.outcome.notes.join(" ")).toMatch(/stdout and stderr are merged/);
  });

  it("reaches the process on Stop, and reports that nothing was proven", async () => {
    const controller = new AbortController();
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm ci")) return fakeProcess("added 12 packages", 0);
      return fakeProcess("running…", 0);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    const running = runInContainer({
      command: "npm test",
      plan: plan(),
      revision: 7,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/stopped/i);
  });

  it("refuses an empty tree instead of booting for nothing", async () => {
    adoptRuntimeForTest(runtimeWith(vi.fn()));
    const empty = planMount({ base: [{ path: "logo.png", content: "x" }], changes: [] });
    const result = await ensureDependencies({ ...empty, tree: empty.tree as FileSystemTree }, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toBeNull();
  });
});
