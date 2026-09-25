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
import { resetRuntimeEnvForTest, setRepoEnvVar } from "./runtime-env";

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

function runtimeWith(
  spawn: ContainerRuntime["spawn"],
  fs: Partial<NonNullable<ContainerRuntime["fs"]>> = {}
): ContainerRuntime {
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
      ...fs,
    },
    spawn,
    on: vi.fn(() => () => {}),
    teardown: vi.fn(async () => {}),
  };
}

/** The install commands the fake runtime was asked to run */
function commandsOf(spawn: ReturnType<typeof vi.fn>): string[] {
  return spawn.mock.calls.map((call) => `${call[0]} ${(call[1] as string[]).join(" ")}`);
}

/**
 * npm's answer when it cannot use the lockfile it was pointed at.
 *
 * Verbatim from the runtime (npm 10.8.2): a file that is missing, empty or not a
 * whole JSON document all produce this text, which is what makes it useless to a
 * reader and unambiguous as a trigger.
 */
function npmCannotUseLockfile(): string {
  return [
    "npm error code EUSAGE",
    "npm error",
    "npm error The `npm ci` command can only install with an existing package-lock.json or",
    "npm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or",
    "npm error later to generate a package-lock.json file, then try again.",
    "npm error",
    "npm error Usage:",
    "npm error npm ci",
    "npm error aliases: clean-install, ic, install-clean, isntall-clean",
  ].join("\n");
}

beforeEach(() => {
  resetContainerQueue();
  resetContainerHost();
  resetRuntimeEnvForTest();
});

afterEach(() => {
  adoptRuntimeForTest(null);
  resetContainerHost();
  resetContainerQueue();
  resetRuntimeEnvForTest();
});

describe("runInContainer — the repo's runtime env reaches the command", () => {
  it("merges the repo's stored vars into the spawn env, over the non-interactive base", async () => {
    // The whole point of the runtime-env layer: a key the user pasted once has
    // to reach `npm run dev` and `npm test` exactly as it reaches the project
    // on a laptop — through the environment, never through a mounted file.
    await setRepoEnvVar("acme", "widgets", "VITE_SUPABASE_URL", "https://x.supabase.co");
    const spawn = vi.fn(async (command: string, args: string[], _options?: { env?: Record<string, string> }) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      return fakeProcess(line.includes("npm ci") ? "added 12 packages" : "2 passed", 0);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    const result = await runInContainer({
      command: "npm test",
      plan: plan(),
      revision: 7,
      repoKey: "acme/widgets",
    });
    expect(result.ok).toBe(true);

    // The LAST spawn is the command itself; its options carry the merged env.
    const calls = spawn.mock.calls;
    const options = calls[calls.length - 1]?.[2] as { env?: Record<string, string> } | undefined;
    expect(options?.env?.VITE_SUPABASE_URL).toBe("https://x.supabase.co");
    // The base env survives the merge — user vars override, never replace.
    expect(options?.env?.CI).toBe("1");
    expect(options?.env?.NO_COLOR).toBe("1");
  });

  it("another repo's vars stay out of this repo's commands", async () => {
    await setRepoEnvVar("acme", "other", "VITE_SECRET_OF_OTHER", "nope");
    await setRepoEnvVar("acme", "widgets", "VITE_MINE", "yes");
    const spawn = vi.fn(async (command: string, args: string[], _options?: { env?: Record<string, string> }) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      return fakeProcess(line.includes("npm ci") ? "added 12 packages" : "2 passed", 0);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    await runInContainer({ command: "npm test", plan: plan(), revision: 7, repoKey: "acme/widgets" });
    const calls = spawn.mock.calls;
    const options = calls[calls.length - 1]?.[2] as { env?: Record<string, string> } | undefined;
    expect(options?.env?.VITE_MINE).toBe("yes");
    expect(options?.env?.VITE_SECRET_OF_OTHER).toBeUndefined();
  });

  it("sends the plain base env when no repo key is given (the tests' own path)", async () => {
    const spawn = vi.fn(async (command: string, args: string[], _options?: { env?: Record<string, string> }) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      return fakeProcess(line.includes("npm ci") ? "added 12 packages" : "2 passed", 0);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    await runInContainer({ command: "npm test", plan: plan(), revision: 7 });
    const calls = spawn.mock.calls;
    const options = calls[calls.length - 1]?.[2] as { env?: Record<string, string> } | undefined;
    expect(options?.env).toEqual({ CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", npm_config_fund: "false", npm_config_audit: "false", npm_config_yes: "true" });
  });
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

  it("keeps the diagnostic lines of a failed install, not npm's usage footer", async () => {
    // The real failure that exposed this: `npm ci` with a lockfile npm rejects at
    // run time exits EUSAGE with a footer of usage boilerplate, and the old tail
    // was that boilerplate alone — the actual cause scrolled past it. The lockfile
    // here is VALID json (the pre-run verdict passes) so this is the plain
    // failure path, not the lockfile-substitution retry.
    const npmOutput = [
      "npm error code EUSAGE",
      "npm error",
      "npm error `npm ci` can only install with an existing package-lock.json",
      "npm error Complete documentation: https://docs.npmjs.com/cli/v10/commands/npm-ci",
      "npm error [-wsl--workspaces] [--include-workspace-root] [--install-links]",
      "npm error aliases: clean-install, ic, install-clean, isntall-clean",
      "npm error Run \"npm help ci\" for more info",
      "npm error A complete log of this run can be found in: /home/.npm/_logs/x-debug-0.log",
    ].join("\n");
    const noLockfilePlan = planMount({
      base: [{ path: "package.json", content: PKG }],
      changes: [],
    });
    const spawn = vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      if (line.includes("npm install")) return fakeProcess(npmOutput, 1);
      throw new Error(`unexpected command: ${line}`);
    });
    adoptRuntimeForTest(runtimeWith(spawn));

    const result = await runInContainer({ command: "npm test", plan: noLockfilePlan, revision: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The lines that name the cause survive…
    expect(result.error).toContain("npm error code EUSAGE");
    expect(result.error).toContain("can only install with an existing package-lock.json");
    // …and the footer that names nothing does not.
    expect(result.error).not.toContain("aliases: clean-install");
    expect(result.error).not.toContain("npm help ci");
    expect(result.error).not.toContain("_logs/x-debug-0.log");
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
    // which surfaced as "the agent cannot run anything after its first
    // command".
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

describe("the lockfile a frozen install rests on — checked, repaired, or given up honestly", () => {
  /** A plan whose lockfile really is the one the revision declares */
  const withLockfile = () =>
    planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: '{"lockfileVersion":3}' },
      ],
      changes: [],
    });

  /** A plan whose lockfile is EMPTY, which is a defect in the revision's read */
  const withEmptyLockfile = () =>
    planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: "" },
      ],
      changes: [],
    });

  const installingSpawn = (answer: (line: string) => ReturnType<typeof fakeProcess> | null) =>
    vi.fn(async (command: string, args: string[]) => {
      const line = `${command} ${args.join(" ")}`;
      if (line.includes("node --version")) return fakeProcess("v22.0.0\n", 0);
      return answer(line) ?? fakeProcess("added 300 packages", 0);
    });

  it("writes the revision's lockfile back when the workspace's copy is empty", async () => {
    // The failure this exists for: the plan has the lockfile (so the frozen
    // command is chosen) and the workspace's copy is empty, which npm reports as
    // "you have no package-lock.json" — a sentence about the repository, for a
    // defect in the mount. The repair keeps the frozen guarantee instead of
    // trading it away for every later command in the thread.
    const spawn = installingSpawn((line) => (line.includes("npm ci") ? fakeProcess("added 300 packages", 0) : null));
    const writeFile = vi.fn(async () => {});
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => ""), writeFile }));

    const result = await ensureDependencies(withLockfile(), 11);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(writeFile).toHaveBeenCalledWith("package-lock.json", '{"lockfileVersion":3}');
    expect(commandsOf(spawn).some((line) => line.includes("npm ci --no-audit --no-fund"))).toBe(true);
    expect(result.notes.join(" ")).toContain("written into the workspace from this revision");
  });

  it("installs without the frozen form — and says so — when the revision's copies are both unusable", async () => {
    const spawn = installingSpawn(() => null);
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => "") }));

    const result = await ensureDependencies(withEmptyLockfile(), 12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commands = commandsOf(spawn);
    expect(commands.some((line) => line.includes("npm ci"))).toBe(false);
    expect(commands.some((line) => line.includes("npm install --no-audit --no-fund"))).toBe(true);
    // The claim has to shrink with the guarantee: a floating install is reported
    // as one, in the same result, or a later green means the wrong thing.
    expect(result.installed).toBe("npm install --no-audit --no-fund");
    const notes = result.notes.join(" ");
    expect(notes).toContain("is empty in the workspace");
    expect(notes).toContain("whatever resolves today");
  });

  it("recognises a truncated lockfile as one it cannot use, not as bytes", async () => {
    const truncated = planMount({
      base: [
        { path: "package.json", content: PKG },
        { path: "package-lock.json", content: '{"name":"demo","lockfileVer' },
      ],
      changes: [],
    });
    const spawn = installingSpawn(() => null);
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => '{"name":"demo","lockfileVer') }));

    const result = await ensureDependencies(truncated, 13);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const notes = result.notes.join(" ");
    expect(notes).toContain("not a complete JSON document");
    expect(result.installed).toBe("npm install --no-audit --no-fund");
  });

  it("retries with the plain install when npm itself refuses the lockfile, and says what the fallback means", async () => {
    // The check above cannot see everything: the workspace's copy can look fine to
    // `fs.readFile` and still be something npm will not use. The retry is keyed to
    // npm's own words — the lockfile-unusable family — and the result names both
    // installs, because only one of them ran.
    const spawn = installingSpawn((line) =>
      line.includes("npm ci") ? fakeProcess(npmCannotUseLockfile(), 1) : null
    );
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => '{"lockfileVersion":3}') }));

    const result = await ensureDependencies(withLockfile(), 14);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toBe("npm install --no-audit --no-fund");
    expect(result.notes.join(" ")).toContain("could not use the workspace's `package-lock.json`");
  });

  it("installs the WebAssembly build the toolchain needs but npm skipped", async () => {
    // The failure this exists for, reproduced in the runtime: Vite 8 bundles with
    // rolldown, whose WebAssembly binding npm never installs (the package declares
    // `cpu: wasm32`, which does not match the platform the runtime reports), so the
    // dev server dies at binding load — `ERR_NAPI_BINDING_TARGET_CONFLICT` from
    // rolldown's own download fallback. Installing the package its loader looks for
    // first makes the loader take the path that stamps it correctly.
    const spawn = installingSpawn((line) => (line.includes("npm ci") ? fakeProcess("added 300 packages", 0) : null));
    const files: Record<string, string> = {
      "package-lock.json": '{"lockfileVersion":3}',
      "node_modules/rolldown/package.json": '{"name":"rolldown","version":"1.2.9"}',
    };
    adoptRuntimeForTest(
      runtimeWith(spawn, {
        readFile: vi.fn(async (path: string) => {
          const content = files[path];
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return content;
        }),
      })
    );

    const result = await ensureDependencies(withLockfile(), 21);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commands = commandsOf(spawn);
    expect(commands.some((line) => line.includes("npm install --no-save --force --no-audit --no-fund @rolldown/binding-wasm32-wasi@1.2.9"))).toBe(true);
    expect(result.notes.join(" ")).toContain("@rolldown/binding-wasm32-wasi@1.2.9");
    expect(result.notes.join(" ")).toContain("Nothing in the repository changed");
  });

  it("leaves a workspace that already has the binding, and one with no such toolchain, alone", async () => {
    const spawn = installingSpawn((line) => (line.includes("npm ci") ? fakeProcess("added 300 packages", 0) : null));
    const readFile = vi.fn(async (path: string) => {
      const files: Record<string, string> = {
        "node_modules/rolldown/package.json": '{"name":"rolldown","version":"1.2.9"}',
        "node_modules/@rolldown/binding-wasm32-wasi/package.json": '{"name":"@rolldown/binding-wasm32-wasi","version":"1.2.9"}',
      };
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    });
    adoptRuntimeForTest(runtimeWith(spawn, { readFile }));

    const withBinding = await ensureDependencies(withLockfile(), 22);
    expect(withBinding.ok).toBe(true);
    // Already resolvable: the loader will find it itself, and a second install
    // would be churn in a tree the user is watching.
    expect(commandsOf(spawn).some((line) => line.includes("npm install --no-save"))).toBe(false);

    // No rolldown in the tree at all: nothing to do, and nothing said.
    spawn.mockClear();
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => { throw new Error("ENOENT"); }) }));
    const withoutToolchain = await ensureDependencies(withEmptyLockfile(), 23);
    expect(withoutToolchain.ok).toBe(true);
    expect(commandsOf(spawn).some((line) => line.includes("npm install --no-save"))).toBe(false);
  });

  it("never fails the install because the binding could not be added", async () => {
    const spawn = installingSpawn((line) => {
      if (line.includes("npm ci")) return fakeProcess("added 300 packages", 0);
      if (line.includes("npm install --no-save")) return fakeProcess("npm error code EACCES", 1);
      return null;
    });
    adoptRuntimeForTest(
      runtimeWith(spawn, {
        readFile: vi.fn(async (path: string) => {
          if (path === "node_modules/rolldown/package.json") return '{"version":"1.2.9"}';
          throw new Error("ENOENT");
        }),
      })
    );

    const result = await ensureDependencies(withLockfile(), 24);
    // A workspace without the binding is the workspace this app had before the
    // step existed; the dev server's own failure, with its hint, is a better report.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.join(" ")).toContain("could not be installed into the workspace");
    expect(result.installed).toBe("npm ci --no-audit --no-fund");
  });

  it("falls back to the plain install when the lockfile is out of sync — announced", async () => {
    // The policy bolt.diy taught and this workspace's nature allows: `ci`'s
    // refusal on a package.json/lockfile disagreement is correct on a laptop
    // (where `install` would edit the repository) and fatal here for no reason —
    // the workspace tree is scratch, and the rewrite reaches the repository only
    // through an explicit push. The refusal is still reported, never silently
    // repaired: the note names the out-of-sync, the substitute command, and the
    // weaker claim a pass makes.
    const spawn = installingSpawn((line) =>
      line.includes("npm ci")
        ? fakeProcess(
            "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync",
            1
          )
        : null
    );
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => '{"lockfileVersion":3}') }));

    const result = await ensureDependencies(withLockfile(), 15);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commandsOf(spawn).some((line) => line.includes("npm install --no-audit --no-fund"))).toBe(true);
    expect(result.notes.join(" ")).toContain("out of sync");
    expect(result.notes.join(" ")).toContain("npm install");
  });

  it("does not retry a failure that has nothing to do with the lockfile", async () => {
    // A network outage or a bad postinstall fails the same way under `install`;
    // substituting there would hide a real failure behind a second failing
    // install and double the wait.
    const spawn = installingSpawn((line) =>
      line.includes("npm ci") ? fakeProcess("npm error network request failed ECONNRESET", 1) : null
    );
    adoptRuntimeForTest(runtimeWith(spawn, { readFile: vi.fn(async () => '{"lockfileVersion":3}') }));

    const result = await ensureDependencies(withLockfile(), 16);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(commandsOf(spawn).some((line) => line.includes("npm install"))).toBe(false);
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
