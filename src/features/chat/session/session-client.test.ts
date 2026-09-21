// ============================================================
// Session Client — Page ⇄ Host Seam Tests
// ============================================================
// These lock in the contract that broke every host-mode send:
// START_TURN must be acknowledged in a way that is *correlated*
// with the request (turnId), never inferred from an ambient
// SNAPSHOT — a stray snapshot used to satisfy the wait, so the page
// abandoned turns the worker had actually started, orphaning them
// behind a spinner that never stopped.
//
// A fake SharedWorker stands in for the host so the whole client
// state machine (handshake, correlation, busy, timeout) is testable
// without a browser.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionHostClient } from "./session-client";
import {
  HOST_PROTOCOL_VERSION,
  type HostEvent,
  type HostRequest,
  type HostSnapshot,
  type HostStartTurnPayload,
} from "./protocol";

// ── Fake SharedWorker port ──────────────────────────────────

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: HostRequest[] = [];
  started = false;
  closed = false;

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  postMessage(msg: HostRequest): void {
    this.posted.push(msg);
  }

  /** Pushes a host → page event */
  emit(event: HostEvent): void {
    this.onmessage?.({ data: event } as MessageEvent);
  }
}

class FakeSharedWorker {
  static instances: FakeSharedWorker[] = [];
  readonly port = new FakePort();

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions
  ) {
    FakeSharedWorker.instances.push(this);
  }
}

interface HostHarness {
  client: SessionHostClient;
  port: FakePort;
}

/** Installs the fake worker; `onRequest` answers host requests */
function installHost(onRequest: (msg: HostRequest, port: FakePort) => void): void {
  FakeSharedWorker.instances = [];
  (globalThis as { SharedWorker?: unknown }).SharedWorker = FakeSharedWorker;
  const original = FakePort.prototype.postMessage;
  FakePort.prototype.postMessage = function (this: FakePort, msg: HostRequest) {
    original.call(this, msg);
    if (msg.type === "HELLO") {
      queueMicrotask(() =>
        this.emit({ type: "HELLO_ACK", protocolVersion: HOST_PROTOCOL_VERSION, workerId: "w1" })
      );
      return;
    }
    onRequest(msg, this);
  };
}

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    turnId: null,
    status: "ended",
    conversationId: null,
    contentFromOffset: 0,
    content: "",
    reasoning: "",
    seq: 0,
    ...overrides,
  };
}

function payload(turnId: string): HostStartTurnPayload {
  return {
    turnId,
    conversationId: "conv1",
    apiKey: "sk-test",
    systemPrompt: "sys",
    temperature: 0.7,
    messages: [{ role: "user", content: "hi" }],
    candidates: [{ modelId: "model-a" }],
  };
}

const originalPostMessage = FakePort.prototype.postMessage;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  FakePort.prototype.postMessage = originalPostMessage;
  delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
  FakeSharedWorker.instances = [];
  vi.useRealTimers();
});

async function connected(onRequest: (msg: HostRequest, port: FakePort) => void): Promise<HostHarness> {
  installHost(onRequest);
  const client = new SessionHostClient();
  const ready = await client.connect();
  expect(ready).toBe(true);
  const port = FakeSharedWorker.instances[0]!.port;
  return { client, port };
}

// ── Tests ───────────────────────────────────────────────────

describe("SessionHostClient handshake", () => {
  it("completes the HELLO handshake exactly once and reports ready", async () => {
    const { client, port } = await connected(() => {});
    expect(client.available).toBe(true);
    expect(client.hostState).toBe("ready");
    expect(port.started).toBe(true);
    expect(port.posted.filter((m) => m.type === "HELLO")).toHaveLength(1);
    client.dispose();
  });

  it("opens exactly ONE port when connect() is called concurrently", async () => {
    installHost(() => {});
    const client = new SessionHostClient();

    // React StrictMode double-mounts effects, so two connects race
    // on the first paint. Two ports would double every event.
    const [a, b] = await Promise.all([client.connect(), client.connect()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(FakeSharedWorker.instances).toHaveLength(1);
    client.dispose();
  });

  it("falls back (never throws) when the host speaks another protocol", async () => {
    FakeSharedWorker.instances = [];
    (globalThis as { SharedWorker?: unknown }).SharedWorker = FakeSharedWorker;
    FakePort.prototype.postMessage = function (this: FakePort, msg: HostRequest) {
      if (msg.type === "HELLO") {
        queueMicrotask(() => this.emit({ type: "PROTOCOL_MISMATCH", hostVersion: 99 }));
      }
    };
    const client = new SessionHostClient();
    expect(await client.connect()).toBe(false);
    expect(client.hostState).toBe("mismatch");
    expect(client.available).toBe(false);
    client.dispose();
  });
});

describe("SessionHostClient.startTurn", () => {
  it("resolves `started` only for the ack correlated with this turnId", async () => {
    const { client, port } = await connected((msg, p) => {
      if (msg.type !== "START_TURN") return;
      // A stray, unsolicited snapshot (another page's attach) must not
      // satisfy the wait.
      p.emit({ type: "SNAPSHOT", snapshot: snapshot() });
      // Nor must another page's turn ack.
      p.emit({
        type: "TURN_STARTED",
        turnId: "someone-elses-turn",
        snapshot: snapshot({ turnId: "someone-elses-turn", status: "streaming" }),
      });
      p.emit({
        type: "TURN_STARTED",
        turnId: msg.payload.turnId,
        snapshot: snapshot({
          turnId: msg.payload.turnId,
          conversationId: "conv1",
          status: "streaming",
          content: "partial ",
        }),
      });
    });

    const outcome = await client.startTurn(payload("t1"));
    expect(outcome.kind).toBe("started");
    if (outcome.kind !== "started") throw new Error("unreachable");
    expect(outcome.snapshot.turnId).toBe("t1");
    expect(outcome.snapshot.content).toBe("partial ");
    client.dispose();
  });

  it("reports `busy` when another conversation owns the host", async () => {
    const { client } = await connected((msg, p) => {
      if (msg.type !== "START_TURN") return;
      p.emit({
        type: "TURN_BUSY",
        snapshot: snapshot({ turnId: "other", conversationId: "conv2", status: "streaming" }),
      });
    });

    const outcome = await client.startTurn(payload("t1"));
    expect(outcome.kind).toBe("busy");
    client.dispose();
  });

  it("resolves `unavailable` (never rejects) when the host never answers", async () => {
    vi.useFakeTimers();
    const { client } = await connected(() => {
      /* a dead worker: requests are posted and ignored */
    });

    const promise = client.startTurn(payload("t1"));
    await vi.advanceTimersByTimeAsync(5_100);
    const outcome = await promise;
    expect(outcome.kind).toBe("unavailable");
    client.dispose();
  });

  it("resolves `unavailable` without posting when the host is not ready", async () => {
    const client = new SessionHostClient();
    const outcome = await client.startTurn(payload("t1"));
    expect(outcome.kind).toBe("unavailable");
    client.dispose();
  });
});

describe("SessionHostClient.fetchSnapshot", () => {
  it("requests an ATTACH and returns the host snapshot", async () => {
    const { client, port } = await connected((msg, p) => {
      if (msg.type !== "ATTACH") return;
      p.emit({
        type: "SNAPSHOT",
        snapshot: snapshot({ turnId: "live", conversationId: "conv1", status: "streaming" }),
      });
    });

    const snap = await client.fetchSnapshot();
    expect(port.posted.some((m) => m.type === "ATTACH")).toBe(true);
    expect(snap?.turnId).toBe("live");
    client.dispose();
  });

  it("returns null rather than rejecting when the host is silent", async () => {
    vi.useFakeTimers();
    const { client } = await connected(() => {});
    const promise = client.fetchSnapshot();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await promise).toBeNull();
    client.dispose();
  });
});

describe("SessionHostClient fan-out", () => {
  it("isolates listeners: one throwing renderer cannot break the turn", async () => {
    const { client, port } = await connected(() => {});
    const seen: HostEvent[] = [];
    client.subscribe(() => {
      throw new Error("bad renderer");
    });
    client.subscribe((e) => seen.push(e));

    port.emit({ type: "DELTA", delta: { turnId: "t1", seq: 1, content: "hi" } });

    expect(seen).toHaveLength(1);
    client.dispose();
  });
});
