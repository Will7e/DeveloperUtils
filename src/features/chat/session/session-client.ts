// ============================================================
// Session Client — Page-Side Bridge to the Session Host
// ============================================================
// Feature-detects SharedWorker. When available, the page becomes a
// thin renderer: it prepares the request (context engine, model
// state, skills) and sends START_TURN; the host owns the actual HTTP
// stream, so it survives page reloads and SPA navigation.
//
// Without SharedWorker (or on host failure), callers transparently
// fall back to the classic in-page streaming loop.

import {
  HOST_PROTOCOL_VERSION,
  type HostDelta,
  type HostEvent,
  type HostRequest,
  type HostSnapshot,
  type HostStartTurnPayload,
} from "./protocol";
import { HOST_HEARTBEAT_MS } from "../constants";

export type HostState = "unsupported" | "connecting" | "ready" | "mismatch";

/**
 * Outcome of a START_TURN request. Correlated by turnId, so a stale
 * or unsolicited snapshot can never be mistaken for this request's
 * acknowledgement (the bug that silently orphaned every host send).
 */
export type StartOutcome =
  | { kind: "started"; snapshot: HostSnapshot }
  | { kind: "busy"; snapshot: HostSnapshot }
  | { kind: "unavailable" };

type EventListener = (event: HostEvent) => void;

/**
 * Correlates a SNAPSHOT reply with the ATTACH that asked for it. With
 * several conversations streaming, "the next snapshot to arrive" is not
 * an answer to any particular question — it could be another page's turn,
 * or one still in flight from an earlier ask.
 */
let attachSeq = 0;
function createAttachRequestId(): string {
  attachSeq += 1;
  return `attach_${Date.now().toString(36)}_${attachSeq.toString(36)}`;
}

/**
 * Page-side handle on the session host. One per app. Reconnects the
 * underlying port after worker replacement (deploy with two tabs).
 */
export class SessionHostClient {
  private worker: SharedWorker | null = null;
  private state: HostState = "unsupported";
  private listeners = new Set<EventListener>();
  private pendingResolvers = new Map<string, (snapshot: HostSnapshot) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private workerId: string | null = null;
  /**
   * The in-flight handshake. Concurrent connect() callers share it
   * instead of each opening their own port: two ports to the same
   * host means every fanned-out event (deltas included) is delivered
   * twice, which renders as a doubled reply and inflates the host's
   * page count so its orphan guard never arms.
   */
  private connectPromise: Promise<boolean> | null = null;

  get hostState(): HostState {
    return this.state;
  }

  get available(): boolean {
    return this.state === "ready";
  }

  /**
   * Opens the worker and performs the HELLO handshake. Resolves to
   * true when the host is usable, false when unsupported/refused.
   */
  async connect(): Promise<boolean> {
    if (this.state === "ready") return true;
    if (typeof SharedWorker === "undefined") {
      this.state = "unsupported";
      return false;
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.handshake();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  /** One handshake, exactly one port */
  private async handshake(): Promise<boolean> {
    this.state = "connecting";
    try {
      this.worker = new SharedWorker(
        new URL("./session-host.worker.ts", import.meta.url),
        { type: "module", name: "intab-session-host" }
      );
      this.worker.port.onmessage = (event: MessageEvent) => this.onEvent(event.data);
      this.worker.port.onmessageerror = () => {
        // Protocol/serialization failure — fall back to in-page
        this.state = "unsupported";
      };
      this.worker.port.start();
      // Handshake
      this.post({ type: "HELLO", protocolVersion: HOST_PROTOCOL_VERSION });
      const ack = await this.waitFor(
        (e) => e.type === "HELLO_ACK" || e.type === "PROTOCOL_MISMATCH",
        5_000
      );
      if (ack.type === "PROTOCOL_MISMATCH") {
        this.state = "mismatch";
        return false;
      }
      this.workerId = ack.type === "HELLO_ACK" ? ack.workerId : null;
      this.state = "ready";
      this.startHeartbeat();
      return true;
    } catch {
      this.state = "unsupported";
      this.worker = null;
      return false;
    }
  }

  /**
   * True once `connect()` has fully completed (ready OR a terminal
   * failure state). A second caller during the handshake must not
   * post HELLO again — racing HELLOs double-deliver the worker's
   * connect-time SNAPSHOT and poison every snapshot waiter.
   */
  get connectSettled(): boolean {
    return this.state !== "connecting";
  }

  /** Subscribes to host events; returns an unsubscribe fn */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Resolves with the replay state of one conversation's live turn.
   *
   * `conversationId` is what makes this the right answer rather than a
   * plausible one: the host holds a turn per conversation, so a page
   * adopting conversation C that accepted D's snapshot would render
   * another chat's answer in C. The requestId echo closes the same hole
   * for replies that arrive a beat late; without a conversationId (the
   * single-turn case) the host answers with its newest live turn.
   */
  async fetchSnapshot(conversationId?: string): Promise<HostSnapshot | null> {
    if (!this.available) return null;
    const requestId = createAttachRequestId();
    const promise = this.waitFor(
      (e) => e.type === "SNAPSHOT" && e.requestId === requestId,
      5_000
    )
      .then((e) => (e.type === "SNAPSHOT" ? e.snapshot : null))
      .catch(() => null);
    this.post({
      type: "ATTACH",
      requestId,
      ...(conversationId ? { conversationId } : {}),
    });
    return promise;
  }

  /**
   * Dispatches START_TURN and resolves its correlated outcome. A
   * timeout resolves `unavailable` (the caller falls back to the
   * in-page transport) rather than rejecting — a rejected wait here
   * used to orphan an already-streaming turn and leave the page's
   * spinner running forever.
   */
  async startTurn(payload: HostStartTurnPayload): Promise<StartOutcome> {
    if (!this.available) return { kind: "unavailable" };
    const promise = this.waitFor(
      (e) =>
        (e.type === "TURN_STARTED" && e.turnId === payload.turnId) ||
        e.type === "TURN_BUSY",
      5_000
    ).catch(() => null);
    this.post({ type: "START_TURN", payload });
    const event = await promise;
    if (event?.type === "TURN_STARTED") return { kind: "started", snapshot: event.snapshot };
    if (event?.type === "TURN_BUSY") return { kind: "busy", snapshot: event.snapshot };
    return { kind: "unavailable" };
  }

  abortTurn(turnId: string): void {
    this.post({ type: "ABORT_TURN", turnId });
  }

  /**
   * Asks the host for its current turn status; the answer arrives on
   * the event stream as STATUS. (There is deliberately no blocking
   * "probe" wrapper: the engine treats a busy host as "retry
   * in-page", so nobody needs to poll one.)
   */
  status(conversationId?: string): void {
    this.post(conversationId ? { type: "STATUS", conversationId } : { type: "STATUS" });
  }

  /** Cleanly detaches this page's port */
  dispose(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.post({ type: "DETACH" });
    try {
      this.worker?.port.close();
    } catch {
      /* already closed */
    }
    this.worker = null;
    this.state = "unsupported";
    this.connectPromise = null;
    this.listeners.clear();
  }

  // ── Internals ──────────────────────────────────────────────

  private post(msg: HostRequest): void {
    try {
      this.worker?.port.postMessage(msg);
    } catch {
      /* port dead — state will fall back on next interaction */
    }
  }

  private waitFor(
    match: (e: HostEvent) => boolean,
    timeoutMs: number
  ): Promise<HostEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("session host timed out"));
      }, timeoutMs);
      const unsubscribe = this.subscribe((event) => {
        if (!match(event)) return;
        cleanup();
        resolve(event);
      });
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
      };
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.post({ type: "HEARTBEAT" });
    }, HOST_HEARTBEAT_MS);
  }

  private onEvent(data: unknown): void {
    if (!data || typeof (data as { type?: unknown }).type !== "string") return;
    const event = data as HostEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* listener isolation */
      }
    }
  }
}

/** Singleton per page */
export const sessionHost = new SessionHostClient();
