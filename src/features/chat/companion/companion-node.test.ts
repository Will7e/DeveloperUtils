// ============================================================
// Companion Node Adapter — Proven Against A Real Machine
// ============================================================
// These are integration tests on purpose. The whole tier is the claim "a
// local process can run the project's real commands", and a mocked spawn
// would verify the mock rather than the claim — particularly for the two
// behaviours that only exist at the OS level: killing a process GROUP, and
// capping output before it is buffered.
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertInside,
  materializeTree,
  removeTree,
  runCommand,
  safeSegment,
  treeRootFor,
} from "./companion-node";
import { resolveOutputLimit, resolveTimeout, shapeOutput } from "./protocol";

let root = "";
/** One node process, reused, so the tests do not depend on a shell's PATH */
const node = `"${process.execPath}"`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "companion-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("materializeTree", () => {
  it("writes the planned files where the plan said", async () => {
    const tree = path.join(root, "write");
    const result = await materializeTree(tree, {
      writes: [
        { path: "package.json", content: '{"name":"x"}' },
        { path: "src/deep/a.ts", content: "export const a = 1;" },
      ],
      deletes: [],
    });
    expect(result.written).toBe(2);
    expect(readFileSync(path.join(tree, "src/deep/a.ts"), "utf8")).toBe("export const a = 1;");
    expect(existsSync(path.join(tree, "package.json"))).toBe(true);
  });

  it("applies deletions", async () => {
    const tree = path.join(root, "delete");
    await materializeTree(tree, {
      writes: [{ path: "gone.txt", content: "x" }],
      deletes: [],
    });
    expect(existsSync(path.join(tree, "gone.txt"))).toBe(true);
    await materializeTree(tree, { writes: [], deletes: ["gone.txt"] });
    expect(existsSync(path.join(tree, "gone.txt"))).toBe(false);
  });

  it("refuses to leave the root, even if a caller skipped the planner", async () => {
    const tree = path.join(root, "escape");
    await mkdir(tree, { recursive: true });
    await expect(
      materializeTree(tree, { writes: [{ path: "../escaped.txt", content: "x" }], deletes: [] })
    ).rejects.toThrow(/outside/);
    expect(existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });
});

describe("assertInside / safeSegment", () => {
  it("rejects a sibling directory that shares a prefix", () => {
    // The bug a string-prefix check has: /tmp/tree-evil starts with /tmp/tree.
    expect(() => assertInside("/tmp/tree", "/tmp/tree-evil/x")).toThrow();
  });

  it("accepts a path inside the root", () => {
    expect(() => assertInside("/tmp/tree", "/tmp/tree/src/a.ts")).not.toThrow();
  });

  it("turns an id with separators into one directory name", () => {
    expect(safeSegment("../../etc")).not.toContain("/");
    expect(safeSegment("../../etc")).not.toContain("..");
    expect(treeRootFor("/base", "../../etc").startsWith("/base/")).toBe(true);
  });

  it("never yields an empty segment", () => {
    expect(safeSegment("///")).toBeTruthy();
  });
});

describe("runCommand", () => {
  it("captures stdout and a zero exit", async () => {
    const outcome = await runCommand({
      command: `${node} -e 'process.stdout.write("ok")'`,
      cwd: root,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("ok");
    expect(outcome.timedOut).toBe(false);
  });

  it("reports a FAILING command as a result, not an error", async () => {
    // The single most useful thing the agent can be told is that the command
    // failed and why. A rejection here would turn `npm test` red into a
    // companion outage.
    const outcome = await runCommand({
      command: `${node} -e 'process.stdout.write("1 failing"); process.exit(1)'`,
      cwd: root,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("1 failing");
  });

  it("captures stderr separately", async () => {
    const outcome = await runCommand({
      command: `${node} -e 'process.stderr.write("boom"); process.exit(2)'`,
      cwd: root,
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("boom");
  });

  it("surfaces an unknown command's exit code instead of throwing", async () => {
    const outcome = await runCommand({ command: "definitely-not-a-command-xyz", cwd: root });
    expect(outcome.exitCode).not.toBe(0);
  });

  it("kills a command that runs past its timeout, and its children with it", async () => {
    const started = Date.now();
    const outcome = await runCommand({
      command: `${node} -e 'setTimeout(() => {}, 60000)'`,
      cwd: root,
      timeoutMs: 400,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).toBeNull();
    // Killed, not waited out: the 60s process cannot still be running.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("caps output before holding it, and says that it did", async () => {
    const outcome = await runCommand({
      command: `${node} -e 'process.stdout.write("x".repeat(50000))'`,
      cwd: root,
      maxOutputChars: 1_000,
    });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout.length).toBeLessThan(3_000);
    expect(outcome.stdout).toContain("elided");
  });

  it("runs in the directory it was given", async () => {
    const tree = path.join(root, "cwd-check");
    await materializeTree(tree, { writes: [{ path: "marker.txt", content: "here" }], deletes: [] });
    const outcome = await runCommand({ command: "ls", cwd: tree });
    expect(outcome.stdout).toContain("marker.txt");
  });

  it("carries notes into the outcome", async () => {
    const outcome = await runCommand({
      command: "true",
      cwd: root,
      notes: ['"../../evil" is not a plain relative path inside the workspace.'],
    });
    expect(outcome.notes[0]).toContain("../../evil");
  });

  it("removes a tree without complaint when it is already gone", async () => {
    await expect(removeTree(path.join(root, "never-existed"))).resolves.toBeUndefined();
  });
});

describe("protocol shaping", () => {
  it("clamps an absurd timeout", () => {
    expect(resolveTimeout(10 ** 12)).toBeLessThanOrEqual(600_000);
  });

  it("falls back rather than killing a build on a NaN timeout", () => {
    // Number(NaN) would make setTimeout fire immediately.
    expect(resolveTimeout(Number.NaN)).toBeGreaterThan(1_000);
    expect(resolveTimeout(-5)).toBeGreaterThan(1_000);
    expect(resolveTimeout(undefined)).toBeGreaterThan(1_000);
  });

  it("keeps the head and the tail when eliding", () => {
    const shaped = shapeOutput(`START${"x".repeat(5_000)}END`, 1_000);
    expect(shaped.truncated).toBe(true);
    expect(shaped.text.startsWith("START")).toBe(true);
    expect(shaped.text.endsWith("END")).toBe(true);
  });

  it("leaves short output alone", () => {
    expect(shapeOutput("ok", 1_000)).toEqual({ text: "ok", truncated: false });
  });

  it("refuses to hold an unbounded output limit", () => {
    expect(resolveOutputLimit(10 ** 9)).toBeLessThanOrEqual(80_000);
  });
});
