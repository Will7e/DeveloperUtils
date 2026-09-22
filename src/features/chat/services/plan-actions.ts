// ============================================================
// Plan Actions — the update_plan tool
// ============================================================
// One job: take the model's plan, validate it, and publish it where the
// user can see it while the turn is still running. The plan is replaced
// wholesale each call (see lib/agent-plan.ts for why), and the tool
// result tells the model what the user is now looking at — including a
// reminder that the plan is a promise about the WORK, not a substitute
// for doing it.

import { useChatStore } from "@/stores/chat.store";
import type { ToolCallResult } from "../types";
import { PlanSpecError, normalizePlan, planProgress, planProgressLine } from "../lib/agent-plan";

export function runUpdatePlan(
  conversationId: string,
  args: Record<string, unknown>
): ToolCallResult {
  const started = Date.now();
  const store = useChatStore.getState();

  // Accept both shapes: `{ steps: [...] }` (documented) and a bare array
  // (what a model often sends for array-ish arguments).
  const raw = Array.isArray(args.steps) ? args.steps : Array.isArray(args.plan) ? args.plan : args.steps;

  let plan;
  try {
    plan = normalizePlan(raw, Date.now());
  } catch (err) {
    if (err instanceof PlanSpecError) {
      return {
        callId: "",
        name: "update_plan",
        ok: false,
        data: {
          error: err.message,
          note:
            "Send the COMPLETE plan every time, with exactly one step marked \"active\" (or all \"done\"). " +
            "The user sees this list, so an invalid plan is rejected rather than silently trimmed.",
        },
        durationMs: Date.now() - started,
        summary: "invalid plan",
      };
    }
    throw err;
  }

  store.setConversationPlan(conversationId, plan.steps.length > 0 ? plan : undefined);
  const progress = planProgress(plan);

  return {
    callId: "",
    name: "update_plan",
    ok: true,
    data: {
      status: plan.complete ? "complete" : "in-progress",
      steps: plan.steps.map((s) => ({ text: s.text, status: s.status })),
      progress: planProgressLine(plan),
      note:
        plan.steps.length === 0
          ? "Plan cleared — the user sees no checklist for this conversation."
          : plan.complete
            ? "The user sees this plan as complete. It is a claim about the work: make sure the change set and any verification actually back it."
            : `The user can watch this list advance (${progress.done}/${progress.total} done). Update it as you go — especially when a step completes — but never mark a step done before the work is in the workspace.`,
    },
    durationMs: Date.now() - started,
    summary: planProgressLine(plan),
  };
}
