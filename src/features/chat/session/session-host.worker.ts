// ============================================================
// Session Host — SharedWorker Shell
// ============================================================
// One instance per browser (per origin): owns the OpenRouter stream
// so turns survive page reloads and SPA navigation. Every chat page
// opens a port; the shell fans host events out to all of them.
//
// Lifecycle rules:
//  - The worker dies when its last client unloads unless a turn is
//    active — the browser is the arbiter, but with no live clients
//    and no work, it terminates promptly. While any page holds a
//    port (including a reload-in-progress page that re-attaches),
//    the stream continues unaffected.
//  - When the last port detaches mid-turn, the orphan guard in
//    HostTurnController grace-waits, then aborts so free-tier daily
//    caps aren't burned by a zombie stream.
//  - No persistence here: the worker holds only the in-flight turn;
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
        // Freshly connected pages immediately learn the current state
        reply(port, { type: "SNAPSHOT", snapshot: controller.snapshot() });
        break;
      }
      case "ATTACH": {
        const meta = ports.get(port);
        if (meta) meta.lastSeen = Date.now();
        controller.setPageCount(ports.size);
        reply(port, { type: "SNAPSHOT", snapshot: controller.snapshot() });
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
        // Only accept a new turn when idle. A second page starting
        // while one runs is refused with TURN_BUSY — unless it is the
        // SAME conversation re-sending after a reload (its old stream
        // is orphaned output nobody renders anymore), in which case
        // the stale turn is aborted and the resend wins.
        // The reply is correlated (TURN_STARTED) so the client never
        // mistakes an unrelated snapshot for its own start ack.
        const current = controller.currentTurn;
        if (current && current.conversationId !== data.payload.conversationId) {
          reply(port, { type: "TURN_BUSY", snapshot: controller.snapshot() });
          return;
        }
        if (current) {
          controller.replaceTurn(data.payload);
        } else {
          controller.startTurn(data.payload);
        }
        reply(port, {
          type: "TURN_STARTED",
          turnId: data.payload.turnId,
          snapshot: controller.snapshot(),
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
      case "REROUTE_REPLY": {
        controller.addCandidates(data.turnId, data.candidates);
        break;
      }
      case "STATUS": {
        reply(port, {
          type: "STATUS",
          turnStatus: controller.currentTurn?.status ?? "ended",
          turnId: controller.currentTurn?.turnId ?? null,
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
