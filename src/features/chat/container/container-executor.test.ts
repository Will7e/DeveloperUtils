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
import {
  adoptRuntimeForTest,
  resetContainerHost,
  workspaceHolder,
  type ContainerRuntime,
} from "./container-host";
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
    // A stream PROPERTY, matching the SDK: as a method it agreed with a wrong
    // interface and the real runtime threw straight into the output pump's catch.
    output: new ReadableStream<string>({
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
    // The filesystem is under `fs`, mirroring the SDK. It was declared on the
    // instance once, which no unit test could catch — a fake implements the
    // interface it is handed — and the real runtime failed with
    // "instance.writeFile is not a function" on every revision after the first.
    fs: {
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    },
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

  it("removes the files the next revision deletes, rather than leaving them in the tree", async () => {
    // `mount()` ADDS. Applying a revision by mounting the new tree over the old
    // filesystem therefore leaves every deleted file in the workspace — and a
    // suite can pass because of a file the change removed, under a claim that
    // the tree is the revision.
    const removed: string[] = [];
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm ci")) return fakeProcess("added 12 packages", 0);
      return fakeProcess("2 passed", 0);
    });
    adoptRuntimeForTest({
      ...runtimeWith(spawn),
      fs: {
        writeFile: vi.fn(async () => {}),
        mkdir: vi.fn(async () => {}),
        rm: vi.fn(async (path: string) => {
          removed.push(path);
        }),
      },
    });

    const before = planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: "{}" },
        { path: "src/old.ts", content: "export const old = 1;" },
      ],
      changes: [],
    });
    const first = await runInContainer({ command: "npm test", plan: before, revision: 1 });
    expect(first.ok).toBe(true);

    const after = planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: "{}" },
      ],
      changes: [],
    });
    const second = await runInContainer({ command: "npm test", plan: after, revision: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(removed).toContain("src/old.ts");
    expect(second.outcome.notes.join(" ")).toMatch(/deletes were removed from the workspace/);
  });

  it("says so when the runtime will not remove a deleted file", async () => {
    // The failure mode this guards is silence: a tree that still holds a file the
    // revision deleted, with nothing in the result saying the run happened
    // against code that no longer exists.
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm ci")) return fakeProcess("added 12 packages", 0);
      return fakeProcess("2 passed", 0);
    });
    // A filesystem with no `rm`: the revision's files can be written and the
    // deleted one cannot be taken out.
    adoptRuntimeForTest({
      ...runtimeWith(spawn),
      fs: { writeFile: vi.fn(async () => {}), mkdir: vi.fn(async () => {}) },
    });

    const before = planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: "{}" },
        { path: "src/old.ts", content: "export const old = 1;" },
      ],
      changes: [],
    });
    await runInContainer({ command: "npm test", plan: before, revision: 1 });

    const after = planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: "{}" },
      ],
      changes: [],
    });
    const second = await runInContainer({ command: "npm test", plan: after, revision: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.outcome.notes.join(" ")).toMatch(/STILL IN the workspace/);
    expect(second.outcome.notes.join(" ")).toMatch(/unproven/);
  });

  it("refuses a runtime with no filesystem instead of running against the previous revision", async () => {
    // The production failure, pinned: the interface once put `writeFile` on the
    // instance, the real SDK keeps it under `fs`, and the first mount succeeded
    // while every later revision threw "instance.writeFile is not a function" —
    // which surfaced as a fall-through to the companion, i.e. "the agent cannot
    // run anything after its first command".
    const spawn = vi.fn(async () => fakeProcess("2 passed", 0));
    adoptRuntimeForTest({
      mount: vi.fn(async () => {}),
      spawn,
      on: vi.fn(() => () => {}),
      teardown: vi.fn(async () => {}),
    });

    const first = await runInContainer({ command: "npm test", plan: plan(), revision: 1 });
    expect(first.ok).toBe(true);
    const second = await runInContainer({ command: "npm test", plan: plan(), revision: 1 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/exposes no filesystem/);
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

describe("the workspace lease — one filesystem, one thread at a time", () => {
  /** A runtime that records a mount and every removal, and can be made unable to remove */
  function recordingRuntime(options: { canRemove?: boolean } = {}) {
    const mounts: string[] = [];
    const removed: string[] = [];
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm ci")) return fakeProcess("added 12 packages", 0);
      return fakeProcess("2 passed", 0);
    });
    const runtime = {
      mount: vi.fn(async () => {
        mounts.push("mount");
      }),
      spawn,
      on: vi.fn(() => () => {}),
      teardown: vi.fn(async () => {}),
      ...(options.canRemove === false
        ? {}
        : {
            fs: {
              writeFile: vi.fn(async () => {}),
              mkdir: vi.fn(async () => {}),
              rm: vi.fn(async (path: string) => {
                removed.push(path);
              }),
            },
          }),
    };
    return { runtime: runtime as ContainerRuntime, mounts, removed };
  }

  const ALICE = { threadId: "alice", label: "fix the parser" };
  const BOB = { threadId: "bob", label: "add a test" };

  it("empties the other thread's tree before mounting this thread's revision", async () => {
    // Without the empty, thread B's command runs in a filesystem that holds both
    // threads' files: a file only alice's revision has is still there, and a
    // passing suite becomes evidence about a tree that exists in no repository.
    const { runtime, mounts, removed } = recordingRuntime();
    adoptRuntimeForTest(runtime);

    const alice = await runInContainer({ command: "npm test", plan: plan(), revision: 1, owner: ALICE });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;
    expect(alice.outcome.notes.join(" ")).not.toMatch(/shared by every thread/);

    const bob = await runInContainer({ command: "npm test", plan: plan(), revision: 2, owner: BOB });
    expect(bob.ok).toBe(true);
    if (!bob.ok) return;
    // A full re-mount, not a delta: the filesystem held alice's files, so every
    // one of them had to go before bob's tree could be called the revision.
    expect(mounts).toHaveLength(2);
    expect(removed).toContain("package.json");
    expect(removed).toContain("package-lock.json");
    expect(bob.outcome.notes.join(" ")).toMatch(/shared by every thread on this page/);
    expect(bob.outcome.notes.join(" ")).toMatch(/fix the parser/);

    // And back again: the lease alternates rather than blocking the second
    // thread out of the tier entirely.
    const aliceAgain = await runInContainer({ command: "npm test", plan: plan(), revision: 1, owner: ALICE });
    expect(aliceAgain.ok).toBe(true);
    expect(mounts).toHaveLength(3);
    expect(workspaceHolder()?.threadId).toBe("alice");
  });

  it("leaves one thread's own tree alone, so a revision is still a delta", async () => {
    const { runtime, mounts, removed } = recordingRuntime();
    adoptRuntimeForTest(runtime);

    await runInContainer({ command: "npm test", plan: plan(), revision: 1, owner: ALICE });
    await runInContainer({ command: "npm test", plan: plan(), revision: 2, owner: ALICE });

    // Re-mounting and re-installing on every revision would make the workspace
    // useless for the single-thread case it was built for.
    expect(mounts).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it("refuses rather than mixing two threads' files when the tree cannot be emptied", async () => {
    // The refusal is the honest outcome, not the limitation: mounting over a tree
    // that cannot be emptied produces a green result about code that exists
    // nowhere, and the caller can fall back to a tier that works.
    const { runtime } = recordingRuntime({ canRemove: false });
    adoptRuntimeForTest(runtime);

    const alice = await runInContainer({ command: "npm test", plan: plan(), revision: 1, owner: ALICE });
    expect(alice.ok).toBe(true);

    const bob = await runInContainer({ command: "npm test", plan: plan(), revision: 2, owner: BOB });
    expect(bob.ok).toBe(false);
    if (bob.ok) return;
    expect(bob.error).toMatch(/mixture of two trees/);
    // The lease never moved, because nothing was mounted for the new owner.
    expect(workspaceHolder()?.threadId).toBe("alice");
  });

  it("gives the workspace up when the thread's repository is torn down", async () => {
    const { runtime } = recordingRuntime();
    adoptRuntimeForTest(runtime);
    await runInContainer({ command: "npm test", plan: plan(), revision: 1, owner: ALICE });
    expect(workspaceHolder()).not.toBeNull();

    resetContainerHost();
    expect(workspaceHolder()).toBeNull();
  });
});
