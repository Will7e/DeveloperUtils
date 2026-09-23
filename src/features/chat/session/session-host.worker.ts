// ============================================================
// Session Host — SharedWorker Shell
// ============================================================
// One instance per browser (per origin): owns the OpenRouter stream
// so turns survive page reloads and SPA navigation. Every chat page
// opens a port; the shell fans host events out to all of them.
//
// The host is the app's multiplexer: it holds ONE TURN PER
// CONVERSATION and streams them concurrently, so a second chat no
// longer waits for the first (and never falls back to a page-local
// stream that dies with its tab). Each turn is addressed by turnId
// on the wire, so a page renders only its own conversation's stream.
//
// Lifecycle rules:
//  - The worker dies when its last client unloads unless a turn is
//    active — the browser is the arbiter, but with no live clients
//    and no work, it terminates promptly. While any page holds a
//    port (including a reload-in-progress page that re-attaches),
//    the streams continue unaffected.
//  - When the last port detaches mid-turn, the orphan guard in
//    HostTurnController grace-waits per turn, then aborts so free-tier
//    daily caps aren't burned by a zombie stream. A page that only
//    navigated to another conversation keeps its turn: the guard asks
//    whether ANY page is left to adopt the stream, not whether one is
//    looking at it right now.
//  - No persistence here: the worker holds only in-flight turns;
//    transcripts live in the page's encrypted store.

import { HOST_PROTOCOL_VERSION, isHostRequest } from "./protocol";
import { HOST_HEARTBEAT_MS } from "../constants";
import { HostTurnController, type HostEventSink } from "./host-controller";
import { logTurnEvent, subscribeTurnLog } from "./turn-log";

/** Stable id for correlating worker restarts in the turn log */
const workerId = `host-${Math.random().toString(36).slice(2, 8)}`;

const ports = new Map<MessagePort, { lastSeen: number }>();

/** Pages renew liveness; dead pages (crashed tab) are reaped here */
function reapDeadPorts(): void {
  const cutoff = Date.now() - HOST_HEARTBEAT_MS * 4;
  let changed = false;
  for (const [port, meta] of ports) {
    if (meta.lastSeen < cutoff) {
      ports.delete(port);
      changed = true;
    }
  }
  if (changed) controller.setPageCount(ports.size);
}

setInterval(reapDeadPorts, HOST_HEARTBEAT_MS);

const sink: HostEventSink = {
  post(event: unknown) {
    for (const port of ports.keys()) {
      try {
        port.postMessage(event);
      } catch {
        // Dead port — dropped; the reaper handles reaping via heartbeats
      }
    }
  },
  get pageCount() {
    return ports.size;
  },
};

const controller = new HostTurnController(sink);

// Mirror the host's log to every page: the decisions that explain a
// weird-looking reply (attempts, failover, race winner, orphan abort)
// are made here, and one console handle should show all of them.
subscribeTurnLog((entry) => {
  sink.post({ type: "LOG", entry });
});

function reply(port: MessagePort, event: unknown): void {
  try {
    port.postMessage(event);
  } catch {
    /* dead port */
  }
}

const ctx = self as unknown as {
  onconnect: ((event: MessageEvent) => void) | null;
};

ctx.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  ports.set(port, { lastSeen: Date.now() });

  logTurnEvent({
    turnId: controller.currentTurn?.turnId ?? null,
    conversationId: null,
    phase: "resume",
    detail: `page attached (${ports.size} live)`,
  });

  port.onmessage = (msg: MessageEvent) => {
    const data: unknown = msg.data;
    if (!isHostRequest(data)) return;

    switch (data.type) {
      case "HELLO": {
        if (data.protocolVersion !== HOST_PROTOCOL_VERSION) {
          reply(port, { type: "PROTOCOL_MISMATCH", hostVersion: HOST_PROTOCOL_VERSION });
          return;
        }
        reply(port, { type: "HELLO_ACK", protocolVersion: HOST_PROTOCOL_VERSION, workerId });
        // Deliberately NO snapshot here: HELLO names no conversation, so a
        // snapshot would be a guess — and with several turns live, an
        // ambiguous one. A page that wants replay asks with ATTACH.
        break;
      }
      case "ATTACH": {
        const meta = ports.get(port);
        if (meta) meta.lastSeen = Date.now();
        controller.setPageCount(ports.size);
        reply(port, {
          type: "SNAPSHOT",
          // Per conversation, and correlated: giving a page that asked
          // about C the stream of D is how one chat's answer would render
          // in another's transcript.
          snapshot: controller.snapshot(data.conversationId),
          ...(data.requestId ? { requestId: data.requestId } : {}),
        });
        break;
      }
      case "DETACH": {
        ports.delete(port);
        controller.setPageCount(ports.size);
        try {
          port.close();
        } catch {
          /* already closed */
        }
        break;
      }
      case "START_TURN": {
        // Admission is per CONVERSATION, and that is the change that makes
        // several agents able to work at once: a send in chat B is admitted
        // while chat A is mid-stream, instead of being refused and quietly
        // degraded to a page-local stream that dies with this tab.
        //
        // A send for a conversation that ALREADY has a live turn replaces
        // it. That is the reload recovery path (that turn's output has no
        // renderer left) and the two-windows-one-chat case, where the
        // newest send is the one the user is looking at. Only this
        // conversation's turn is touched.
        //
        // The reply stays correlated (TURN_STARTED + turnId) so the client
        // never mistakes an unrelated snapshot for its own start ack, and
        // it carries the snapshot of THIS conversation's turn.
        const existing = controller.turnFor(data.payload.conversationId);
        if (existing) {
          controller.replaceTurn(data.payload);
        } else if (!controller.startTurn(data.payload)) {
          reply(port, {
            type: "TURN_BUSY",
            snapshot: controller.snapshot(data.payload.conversationId),
          });
          return;
        }
        reply(port, {
          type: "TURN_STARTED",
          turnId: data.payload.turnId,
          snapshot: controller.snapshot(data.payload.conversationId),
        });
        break;
      }
      case "ABORT_TURN": {
        const meta = ports.get(port);
        if (meta) meta.lastSeen = Date.now();
        controller.abortTurn(data.turnId);
        break;
      }
      case "HEARTBEAT": {
        const meta = ports.get(port);
        if (meta) meta.lastSeen = Date.now();
        break;
      }
      case "STATUS": {
        const turn = data.conversationId
          ? controller.turnFor(data.conversationId)
          : controller.currentTurn;
        reply(port, {
          type: "STATUS",
          turnStatus: turn?.status ?? "ended",
          turnId: turn?.turnId ?? null,
          liveTurns: controller.liveTurnCount,
        });
        break;
      }
    }
  };

  port.onmessageerror = () => {
    ports.delete(port);
    controller.setPageCount(ports.size);
  };

  port.addEventListener("close", () => {
    ports.delete(port);
    controller.setPageCount(ports.size);
  });

  controller.setPageCount(ports.size);
};
