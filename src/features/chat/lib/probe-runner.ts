// ============================================================
// Probe Runner — the verify_behavior tool behind the bridge
// ============================================================
// Split out of agent-actions.ts because this is a service with one job:
// take the model's probe declaration, get the preview onto the current
// build, execute the probes, and turn the answer into (a) a tool result
// the model can act on and (b) a verification ledger entry a reviewer can
// check. It is also the only place that decides whether a run counts as
// evidence at all — a run against a stale build is not evidence, it is a
// footnote.

import { useChatStore } from "@/stores/chat.store";
import { usePreviewStore } from "../preview/preview.store";
import { runJsInPreview } from "../preview/preview-bridge";
import { runPreviewBuild } from "../preview/preview-runtime";
import type { ToolCallResult } from "../types";
import {
  ProbeSpecError,
  buildProbeScript,
  formatProbeReport,
  interpretProbeReport,
  normalizeProbes,
  probeFailureDetails,
  probeSummaryLine,
} from "./probe-spec";
import { recordVerification } from "./verification-ledger";

/** Probes run in the user's browser on their tab: bound the work per turn. */
const PROBES_PER_TURN = 2;
let probeRunsThisTurn = 0;
let probeTurnId = "";

/** Called when the user sends a new message — resets the per-turn cap. */
export function resetProbeCounter(conversationId: string): void {
  if (probeTurnId === conversationId) {
    probeTurnId = conversationId;
    probeRunsThisTurn = 0;
  }
}

function consumeProbeSlot(conversationId: string): string | null {
  if (probeTurnId !== conversationId) {
    probeTurnId = conversationId;
    probeRunsThisTurn = 0;
  }
  if (probeRunsThisTurn >= PROBES_PER_TURN) {
    return (
      `Behaviour-probe limit reached for this turn (${PROBES_PER_TURN} runs). ` +
      "Fix what the last run reported, then verify again on the user's next message."
    );
  }
  probeRunsThisTurn += 1;
  return null;
}

/** True when the workspace changed after the given timestamp. */
function workspaceChangedSince(conversationId: string, ts: number): boolean {
  const ws = useChatStore.getState().workspaces[conversationId];
  return Boolean(ws && ws.updatedAt > ts);
}

export async function runVerifyBehavior(
  conversationId: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const started = Date.now();
  const fail = (error: string, summary: string, data: Record<string, unknown> = {}): ToolCallResult => ({
    callId: "",
    name: "verify_behavior",
    ok: false,
    data: { error, ...data },
    durationMs: Date.now() - started,
    summary,
  });

  let plan;
  try {
    plan = normalizeProbes(args.probes);
  } catch (err) {
    // A malformed declaration is the model's to fix, so the message keeps
    // the offending detail rather than a generic "invalid argument".
    if (err instanceof ProbeSpecError) return fail(err.message, "invalid probes");
    throw err;
  }

  const capErr = consumeProbeSlot(conversationId);
  if (capErr) return fail(capErr, "probe limit reached");

  const store = useChatStore.getState();
  const ws = store.workspaces[conversationId];
  if (!ws) return fail("No workspace available — attach a repository first.", "no workspace");

  // Probes must describe the code as it is now: if files changed after the
  // last build finished, rebuild synchronously so the run is meaningful.
  const preview = usePreviewStore.getState();
  if (preview.conversationId && preview.conversationId !== conversationId) {
    return fail(
      "The preview is showing a different conversation. Open this conversation's preview, then retry.",
      "wrong preview"
    );
  }
  if (preview.builtAt > 0 && workspaceChangedSince(conversationId, preview.builtAt)) {
    await runPreviewBuild(ws);
  }
  const freshUntil = Date.now() + 4_000;
  while (!usePreviewStore.getState().runtimeReady && Date.now() < freshUntil) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!usePreviewStore.getState().runtimeReady) {
    return fail(
      "The preview has not finished starting, so nothing could be probed. Check get_preview_feedback for build errors first.",
      "preview not ready"
    );
  }

  const revision = ws.updatedAt;
  const outcome = await runJsInPreview(buildProbeScript(plan.probes));
  if (!outcome.ok) {
    // The script itself failed to run — that is not a failed probe, and
    // saying so would let a broken harness look like a bug in the app.
    return fail(
      `The preview could not run the probes: ${outcome.error ?? "unknown error"}. This is a harness failure, not a result about your change.`,
      "probe harness error"
    );
  }

  const report = interpretProbeReport(outcome.result);
  const changedDuringRun = workspaceChangedSince(conversationId, revision);

  // Evidence is recorded only when it is about the revision just probed.
  // A mid-run edit (or a failed parse) gets no ledger entry at all: an
  // unusable result that still showed up at the push gate as "probes ran"
  // would be worse than no evidence.
  if (!report.parseError) {
    recordVerification(conversationId, {
      kind: "probes",
      at: started,
      workspaceUpdatedAt: revision,
      ok: report.failed === 0,
      summary: probeSummaryLine(report),
      details: probeFailureDetails(report),
      source: "verify_behavior",
    });
  }

  const lines = formatProbeReport(report);
  const data: Record<string, unknown> = {
    status: report.parseError ? "unreadable" : report.failed === 0 ? "passed" : "failed",
    summary: probeSummaryLine(report),
    probes: report.results.map((r) => ({ name: r.name, ok: r.ok, steps: r.steps, failures: r.failures })),
    detail: lines,
    ...(report.consoleErrors.length > 0 ? { consoleErrors: report.consoleErrors } : {}),
    ...(plan.notes.length > 0 ? { notes: plan.notes } : {}),
    ...(changedDuringRun
      ? {
          warning:
            "The workspace changed while the probes were running, so this result describes the previous revision. Re-run before relying on it.",
        }
      : {}),
    ...(report.parseError
      ? { error: report.parseError }
      : report.failed > 0
        ? {
            note:
              "These are real failures in the running app, not assertion typos: fix the behaviour (or, if a probe itself is wrong, say so explicitly and re-run with a corrected probe). Do not describe the flow as working while this reports failures.",
          }
        : {
            note:
              "Recorded as evidence for this revision: a failed later edit invalidates it, and a passing run is attached to the pull request as proof.",
          }),
  };

  return {
    callId: "",
    name: "verify_behavior",
    ok: !report.parseError && report.failed === 0,
    data,
    durationMs: Date.now() - started,
    summary: probeSummaryLine(report),
  };
}
