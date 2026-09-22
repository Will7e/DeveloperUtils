// ============================================================
// Agent Plan — the model's own step checklist, kept honest
// ============================================================
// Every serious coding agent shows a plan while it works. The reason is
// not decoration: a long turn is otherwise unreadable, and a user who
// cannot see the steps cannot tell "thinking hard" from "stuck in a loop"
// or stop it before it does the wrong third of the job.
//
// Two rules keep the plan useful rather than theatrical:
//
//   * It is REPLACED, never appended. The model re-states the whole plan
//     each time, so what the user sees is always the current intention —
//     a plan that only grows would preserve steps the agent already
//     abandoned.
//   * Exactly one step is active. A model that marks four steps active is
//     not executing a plan, and a checklist that cannot be read at a
//     glance is worse than no checklist.

import type { AgentPlan, PlanStatus, PlanStep } from "../types";

export class PlanSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanSpecError";
  }
}

export const MAX_PLAN_STEPS = 12;
export const MAX_STEP_TEXT = 200;

const STATUSES: ReadonlySet<string> = new Set(["pending", "active", "done"]);

/** A stable-ish id for a step, derived from its text when none is given. */
function stepId(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `s${index}-${slug}` : `s${index}`;
}

function coerceStatus(value: unknown, index: number): PlanStatus {
  if (value === undefined || value === null) return "pending";
  if (typeof value !== "string" || !STATUSES.has(value)) {
    throw new PlanSpecError(
      `step ${index + 1}: status ${JSON.stringify(value)} is not one of pending, active, done.`
    );
  }
  return value as PlanStatus;
}

/**
 * Validates the model's plan. Strict on purpose: a plan that silently
 * drops the steps the model got wrong would show the user a plan the
 * agent never agreed to, and the agent would be told it succeeded.
 */
export function normalizePlan(raw: unknown, now: number): AgentPlan {
  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === "object" && raw !== null && Array.isArray((raw as { steps?: unknown }).steps)) {
    entries = (raw as { steps: unknown[] }).steps;
  } else {
    throw new PlanSpecError(
      'Provide "steps": an array of the whole plan, each entry { text, status?: "pending" | "active" | "done" }.'
    );
  }

  if (entries.length === 0) {
    // An empty plan is a legitimate "I am done / nothing to do" signal.
    return { steps: [], updatedAt: now, complete: true };
  }
  if (entries.length > MAX_PLAN_STEPS) {
    throw new PlanSpecError(
      `${entries.length} steps provided (max ${MAX_PLAN_STEPS}). A plan is a summary of the work, not a transcript — group the remainder.`
    );
  }

  const steps: PlanStep[] = entries.map((entry, i) => {
    const record = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const rawText = typeof record.text === "string" ? record.text.trim() : "";
    if (!rawText) throw new PlanSpecError(`step ${i + 1}: needs non-empty "text".`);
    const text = rawText.length > MAX_STEP_TEXT ? `${rawText.slice(0, MAX_STEP_TEXT)}…` : rawText;
    const status = coerceStatus(record.status, i);
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 60) : stepId(text, i);
    return { id, text, status };
  });

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) step.id = `${step.id}-${seen.size}`;
    seen.add(step.id);
  }

  const active = steps.filter((s) => s.status === "active");
  if (active.length > 1) {
    throw new PlanSpecError(
      `${active.length} steps are marked "active", but only one step can be in progress. ` +
        "Mark the finished ones \"done\" and the rest \"pending\"."
    );
  }

  // Completeness is derived, never declared: it is true only when every
  // step is done, which also makes "complete with a step still running"
  // unrepresentable rather than merely rejected.
  const complete = steps.every((s) => s.status === "done");
  return { steps, updatedAt: now, complete };
}

export interface PlanProgress {
  total: number;
  done: number;
  active: PlanStep | null;
  /** The first step that is not done — what the agent says it is doing next */
  next: PlanStep | null;
}

export function planProgress(plan: AgentPlan | undefined | null): PlanProgress {
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;
  return {
    total: steps.length,
    done,
    active: steps.find((s) => s.status === "active") ?? null,
    next: steps.find((s) => s.status !== "done") ?? null,
  };
}

/** "Step 3 of 7 · wiring the route" — the one line a header can show. */
export function planProgressLine(plan: AgentPlan | undefined | null): string {
  const steps = plan?.steps ?? [];
  const { total, done, active, next } = planProgress(plan);
  if (total === 0) return "No plan";
  if (done === total) return `All ${total} steps done`;
  const current = active ?? next;
  const index = current ? steps.findIndex((s) => s.id === current.id) + 1 : done + 1;
  return `Step ${index} of ${total}${current ? ` · ${current.text}` : ""}`;
}
