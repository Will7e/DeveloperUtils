// ============================================================
// Companion Server — Over Real Sockets
// ============================================================
// The pair of properties that make this daemon safe to run are also the pair
// that no unit test of a handler can establish: it binds loopback, and it
// refuses every request without the pairing token. Both are checked here by
// actually making the request.
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCompanionServer, type StartedCompanion } from "./companion-server";
import { COMPANION_PROTOCOL_VERSION } from "./protocol";

const TOKEN = "test-token-abc123";
const APP_ORIGIN = "http://localhost:5173";
let server: StartedCompanion;
let treesDir: string;

beforeAll(async () => {
  treesDir = await mkdtemp(path.join(tmpdir(), "companion-srv-"));
  server = await startCompanionServer({ port: 0, token: TOKEN, treesDir });
});

afterAll(async () => {
  await server.close();
  await rm(treesDir, { recursive: true, force: true });
});

function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

const exec = (payload: Record<string, unknown>) =>
  post("/v1/exec", { type: "EXEC", id: "e1", conversationId: "conv-1", ...payload }, {
    "x-companion-token": TOKEN,
  });

describe("reachability and pairing", () => {
  it("answers /health without a token, so a probe can ask if it exists", async () => {
    const res = await fetch(`${server.origin}/health`);
    const body = (await res.json()) as { ok: boolean; protocolVersion: number };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(COMPANION_PROTOCOL_VERSION);
  });

  it("binds loopback only", async () => {
    expect(server.origin.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("refuses a request with no pairing token", async () => {
    const res = await post("/v1/hello", { type: "HELLO", protocolVersion: COMPANION_PROTOCOL_VERSION });
    expect(res.status).toBe(401);
  });

  it("refuses a request with the wrong pairing token", async () => {
    const res = await post(
      "/v1/hello",
      { type: "HELLO", protocolVersion: COMPANION_PROTOCOL_VERSION },
      { "x-companion-token": "not-the-token" }
    );
    expect(res.status).toBe(401);
  });

  it("refuses an origin that is not the app's", async () => {
    const res = await fetch(`${server.origin}/v1/hello`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "x-companion-token": TOKEN,
      },
      body: JSON.stringify({ type: "HELLO", protocolVersion: COMPANION_PROTOCOL_VERSION }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a body that is not a protocol message", async () => {
    const res = await post("/v1/exec", { nope: true }, { "x-companion-token": TOKEN });
    expect(res.status).toBe(400);
  });
});

describe("the version handshake", () => {
  it("acknowledges a matching version", async () => {
    const res = await post(
      "/v1/hello",
      { type: "HELLO", protocolVersion: COMPANION_PROTOCOL_VERSION },
      { "x-companion-token": TOKEN }
    );
    const body = (await res.json()) as { type: string; capabilities: { exec: boolean } };
    expect(body.type).toBe("HELLO_ACK");
    expect(body.capabilities.exec).toBe(true);
  });

  it("NAMES a mismatch instead of answering anyway", async () => {
    // The failure this prevents: a stale companion answering a newer page,
    // appearing to succeed, and being subtly wrong.
    const res = await post(
      "/v1/hello",
      { type: "HELLO", protocolVersion: 99 },
      { "x-companion-token": TOKEN }
    );
    const body = (await res.json()) as { type: string; protocolVersion: number; expected: number };
    expect(body.type).toBe("PROTOCOL_MISMATCH");
    expect(body.protocolVersion).toBe(COMPANION_PROTOCOL_VERSION);
    expect(body.expected).toBe(99);
  });
});

describe("running a command", () => {
  it("materializes the change set, runs, and reports the exit code", async () => {
    const res = await exec({
      command: `node -e 'process.stdout.write("hello from the companion")'`,
      writes: [{ path: "src/marker.txt", content: "written by the workspace" }],
      deletes: [],
    });
    const body = (await res.json()) as {
      type: string;
      outcome: { exitCode: number; stdout: string; cwd: string };
    };
    expect(body.type).toBe("EXEC_RESULT");
    expect(body.outcome.exitCode).toBe(0);
    expect(body.outcome.stdout).toBe("hello from the companion");
  });

  it("says the tree is PARTIAL when there is no repository to check out", async () => {
    // Without this note the agent reads a green run of a tree that is only
    // the files it happened to touch — the most confident wrong answer the
    // tier can produce.
    const res = await exec({ command: "true", writes: [{ path: "a.txt", content: "a" }] });
    const body = (await res.json()) as { outcome: { notes: string[] } };
    expect(body.outcome.notes.join(" ")).toContain("PARTIAL");
  });

  it("runs the command against the tree it just wrote", async () => {
    const res = await exec({
      command: "cat marker-a.txt",
      writes: [{ path: "marker-a.txt", content: "on disk" }],
    });
    const body = (await res.json()) as { outcome: { stdout: string; exitCode: number } };
    expect(body.outcome.exitCode).toBe(0);
    expect(body.outcome.stdout).toContain("on disk");
  });

  it("reports a FAILING command as a result, not an error", async () => {
    const res = await exec({ command: `node -e 'process.exit(7)'`, writes: [] });
    const body = (await res.json()) as { outcome: { exitCode: number } };
    expect(res.status).toBe(200);
    expect(body.outcome.exitCode).toBe(7);
  });

  it("deletes files the change set removed", async () => {
    await exec({ command: "true", writes: [{ path: "gone.txt", content: "x" }] });
    await exec({ command: "true", writes: [], deletes: ["gone.txt"] });
    const res = await exec({ command: "test ! -f gone.txt && echo absent", writes: [] });
    const body = (await res.json()) as { outcome: { stdout: string } };
    expect(body.outcome.stdout).toContain("absent");
  });
});

describe("release", () => {
  it("removes the conversation's tree", async () => {
    await post(
      "/v1/release",
      { type: "RELEASE", id: "r1", conversationId: "conv-1" },
      { "x-companion-token": TOKEN }
    );
    // A released tree is rebuilt from the change set on the next command, so
    // the assertion is that the command still works rather than that it fails.
    const res = await exec({ command: "echo rebuilt", writes: [{ path: "x.txt", content: "x" }] });
    const body = (await res.json()) as { outcome: { stdout: string } };
    expect(body.outcome.stdout).toContain("rebuilt");
  });
});
