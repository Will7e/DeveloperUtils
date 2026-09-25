// ============================================================
// Strand Executor — Quiet Tool Execution Against A Fork (Braid P2)
// ============================================================
// The engine's executeToolPhase is coupled to the store: it commits
// transcript rows, consults the shared tool cache and the approval
// gates. A strand must do none of that — it works an isolated
// WorkspaceState VALUE, leaves no transcript rows, records no ledger
// evidence (its verification is its own return value, never the main
// ledger's — a strand's bytes are not the workspace's bytes), and
// talks to no human.
//
// Surface: exactly the STRAND_TOOL_NAMES set, re-asserted here because
// the executor is the last line of defense, not the offer list.

import {
  collectChanges,
  deleteFile,
  readFile,
  writeFile,
} from "../workspace/workspace";
import { runTypecheck } from "../lib/typecheck-client";
import { isStrandCall, strandRefusalText } from "./strand";
import type { ToolCallRequest, ToolCallResult, WorkspaceState } from "../types";

const STRAND_TOOL_RESULT_MAX_CHARS = 10_000;

/**
 * Relative verification: on a repository whose BASELINE already has type
 * errors, an absolute "0 errors" standard means nothing can ever verify
 * — not the strands, and not the main path either — so a rescue becomes
 * impossible exactly where it is most needed. A strand therefore verifies
 * when it holds the baseline (never regressed it), and when the baseline
 * is unknown (the capture failed) the strict standard applies.
 * Exported pure for tests.
 */
export function strandCheckOk(baselineErrors: number | null, reported: number): boolean {
  return baselineErrors === null ? reported === 0 : reported <= baselineErrors;
}

export interface StrandExecutor {
  /** The fork's current workspace value (mutated by write/edit/delete) */
  readonly ws: WorkspaceState;
  execute: (call: ToolCallRequest) => Promise<ToolCallResult>;
}

/** Creates a strand executor over one forked workspace value */
export function createStrandExecutor(
  initialWs: WorkspaceState,
  token: string,
  signal: AbortSignal
): StrandExecutor {
  let ws = initialWs;

  // Baseline error count of the FORK AS IT STARTED (which includes any
  // unverified edits the main turn had already made). Captured lazily
  // because re-running the baseline compile inside the first run_checks is
  // wasteful — so it is captured once, here, in the background; until it
  // lands, the strict standard applies. A failed capture stays null → strict.
  let baselineErrors: number | null = null;
  void (async () => {
    try {
      const check = await runTypecheck({
        files: Object.entries(initialWs.files)
          .filter(([, f]) => f.status !== "deleted")
          .map(([p, f]) => ({ path: p, content: f.content })),
        tsconfigRaw:
          initialWs.files["tsconfig.json"]?.content ??
          initialWs.files["jsconfig.json"]?.content ??
          null,
        treePaths: initialWs.tree.map((e) => e.path),
      });
      if (!check.ok) return; // unavailable → baseline stays null → strict
      baselineErrors = check.classification.reported.length;
    } catch {
      // stays null
    }
  })();

  const result = (
    call: ToolCallRequest,
    ok: boolean,
    data: unknown,
    summary?: string
  ): ToolCallResult => ({
    callId: call.id,
    name: call.name,
    ok,
    data,
    durationMs: 0,
    ...(summary ? { summary } : {}),
  });

  return {
    get ws() {
      return ws;
    },
    async execute(call: ToolCallRequest): Promise<ToolCallResult> {
      if (signal.aborted) {
        return result(call, false, { error: "strand aborted" });
      }
      if (!isStrandCall(call.name)) {
        return result(call, false, { error: strandRefusalText(call.name) });
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        return result(call, false, { error: "invalid arguments (unparseable JSON)" });
      }
      const path = typeof args.path === "string" ? args.path : "";

      switch (call.name) {
        case "read_file": {
          if (!path) return result(call, false, { error: "read_file needs a path" });
          const read = await readFile(ws, token, path);
          ws = read.ws;
          if (read.content === null) {
            return result(call, false, { error: read.error ?? "unreadable" }, path);
          }
          const content =
            read.content.length > STRAND_TOOL_RESULT_MAX_CHARS
              ? `${read.content.slice(0, STRAND_TOOL_RESULT_MAX_CHARS)}… [elided]`
              : read.content;
          return result(call, true, { path, content }, path);
        }
        case "search_workspace": {
          const needle = typeof args.query === "string" ? args.query.toLowerCase() : "";
          if (!needle) return result(call, false, { error: "search_workspace needs a query" });
          const hits: string[] = [];
          for (const [p, file] of Object.entries(ws.files)) {
            if (file.status === "deleted") continue;
            if (p.toLowerCase().includes(needle)) hits.push(p);
            if (file.content.toLowerCase().includes(needle) && !hits.includes(p)) hits.push(p);
            if (hits.length >= 25) break;
          }
          for (const entry of ws.tree) {
            if (hits.length >= 25) break;
            if (entry.path.toLowerCase().includes(needle) && !hits.includes(entry.path)) {
              hits.push(entry.path);
            }
          }
          return result(call, true, { matches: hits }, `${hits.length} match(es)`);
        }
        case "get_workspace_diff": {
          const changes = collectChanges(ws).map((c) => ({
            path: c.path,
            status: c.status,
          }));
          return result(call, true, { changes }, `${changes.length} changed file(s)`);
        }
        case "write_file": {
          const content = typeof args.content === "string" ? args.content : null;
          if (!path || content === null) {
            return result(call, false, { error: "write_file needs path and content" });
          }
          const write = writeFile(ws, path, content);
          ws = write.ws;
          return write.ok
            ? result(call, true, { path, written: true }, path)
            : result(call, false, { error: write.error ?? "write failed" }, path);
        }
        case "edit_file": {
          const search = typeof args.search === "string" ? args.search : "";
          const replace = typeof args.replace === "string" ? args.replace : "";
          if (!path || !search) {
            return result(call, false, { error: "edit_file needs path and search" });
          }
          const existing = ws.files[path];
          if (!existing || existing.status === "deleted") {
            return result(call, false, { error: `File '${path}' is not loaded — read it first.` }, path);
          }
          if (!existing.content.includes(search)) {
            return result(call, false, { error: `search text not found in '${path}'` }, path);
          }
          const next = existing.content.replace(search, replace);
          const write = writeFile(ws, path, next);
          ws = write.ws;
          return write.ok
            ? result(call, true, { path, edited: true }, path)
            : result(call, false, { error: write.error ?? "edit failed" }, path);
        }
        case "delete_file": {
          if (!path) return result(call, false, { error: "delete_file needs a path" });
          const del = deleteFile(ws, path);
          ws = del.ws;
          return del.ok
            ? result(call, true, { path, deleted: true }, path)
            : result(call, false, { error: del.error ?? "delete failed" }, path);
        }
        case "run_checks": {
          // The in-browser type check over the FORK's own files. This is
          // the only verification a strand can earn, and its result feeds
          // `StrandResult.verified` — it is deliberately NOT recorded in
          // the main verification ledger: the fork's bytes are not the
          // workspace's bytes, and a ledger entry about them would be a
          // claim about code that may never exist.
          const files = Object.entries(ws.files)
            .filter(([, f]) => f.status !== "deleted")
            .map(([p, f]) => ({ path: p, content: f.content }));
          const check = await runTypecheck({
            files,
            tsconfigRaw:
              ws.files["tsconfig.json"]?.content ??
              ws.files["jsconfig.json"]?.content ??
              null,
            treePaths: ws.tree.map((e) => e.path),
          });
          const reported = check.classification.reported.length;
          const verified = strandCheckOk(baselineErrors, reported);
          return result(
            call,
            check.ok && verified,
            {
              ran: check.ok,
              errors: reported,
              ...(baselineErrors !== null ? { baselineErrors } : {}),
              ...(check.unavailableReason ? { unavailable: check.unavailableReason } : {}),
              ...(reported > 0
                ? {
                    first: check.classification.reported
                      .slice(0, 6)
                      .map((d) => `${d.file ?? "(project)"}:${d.line ?? "?"} TS${d.code}: ${d.message.split("\n")[0] ?? d.message}`),
                  }
                : {}),
            },
            check.ok
              ? baselineErrors !== null && reported > baselineErrors
                ? `typecheck: ${reported} error(s) — WORSE than the ${baselineErrors} it started with`
                : `typecheck: ${reported} error(s) (baseline ${baselineErrors ?? 0})`
              : "typecheck unavailable"
          );
        }
        case "update_plan": {
          // Strand plans are private to the rollout — publishing one to
          // the conversation would show the user a plan for work that may
          // be discarded at the join.
          return result(call, true, { note: "strand-local plan recorded" });
        }
        default:
          return result(call, false, { error: strandRefusalText(call.name) });
      }
    },
  };
}
