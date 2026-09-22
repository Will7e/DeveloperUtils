// ============================================================
// PlanStrip — the agent's plan, visible while it works
// ============================================================
// A long agent turn with no visible plan is indistinguishable from a hung
// one. This renders the model's own checklist next to the composer, where
// the user is already looking, so "step 3 of 7 · verify in preview" answers
// the question they are actually asking the whole time.
//
// It stays small on purpose: one line per step, collapsed once every step
// is done (still openable — a completed plan is the record of what the
// turn claimed to do), and nothing at all when there is no plan, because
// an empty checklist is noise.

import React from "react";
import { Check, ChevronDown, ChevronRight, Circle, Loader2, ListChecks } from "lucide-react";
import { useChatStore } from "@/stores/chat.store";
import { planProgress, planProgressLine } from "../lib/agent-plan";
import type { PlanStep } from "../types";

const STEP_ICON: Record<PlanStep["status"], React.ReactNode> = {
  done: <Check className="h-3.5 w-3.5 chat-plan-icon-done" aria-hidden="true" />,
  active: <Loader2 className="h-3.5 w-3.5 chat-plan-icon-active spin" aria-hidden="true" />,
  pending: <Circle className="h-3.5 w-3.5 chat-plan-icon-pending" aria-hidden="true" />,
};

const STATUS_LABEL: Record<PlanStep["status"], string> = {
  done: "done",
  active: "in progress",
  pending: "not started",
};

export const PlanStrip = React.memo(function PlanStrip({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const plan = useChatStore((s) =>
    conversationId ? s.conversations.find((c) => c.id === conversationId)?.plan : undefined
  );
  // A plan the user collapsed stays collapsed as its steps tick over; a
  // NEW plan opens itself, because that is the moment it matters. Doing it
  // during render (React's documented adjust-state-when-input-changes
  // escape hatch) avoids an effect pass that would briefly paint the old
  // collapsed state over the new plan.
  const planKey = plan?.updatedAt ? `${plan.updatedAt}` : "";
  // A finished plan starts collapsed — the work is the transcript's business
  // now — but it stays openable, because it is also the record of what the
  // turn claimed to do. Forcing it shut would hide that record.
  const startsCollapsed = Boolean(plan?.complete);
  const [view, setView] = React.useState({ planKey, collapsed: startsCollapsed });
  if (view.planKey !== planKey) setView({ planKey, collapsed: startsCollapsed });

  const steps = plan?.steps ?? [];
  if (steps.length === 0) return null;

  const { done, total } = planProgress(plan);
  const collapsed = view.collapsed;

  return (
    <section className="chat-plan" aria-label="Agent plan">
      <button
        type="button"
        className="chat-plan-header"
        onClick={() => setView((v) => ({ ...v, collapsed: !v.collapsed }))}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="chat-plan-title">
          {total > 0 && done === total ? "Plan complete" : "Plan"}
        </span>
        <span className="chat-plan-progress" aria-hidden="true">
          {done}/{total}
        </span>
        <span className="chat-plan-current">{planProgressLine(plan)}</span>
      </button>

      {!collapsed && (
        <ol className="chat-plan-steps">
          {steps.map((step) => (
            <li key={step.id} className={`chat-plan-step chat-plan-step-${step.status}`}>
              {STEP_ICON[step.status]}
              <span className="chat-plan-text">{step.text}</span>
              <span className="chat-plan-sr">{STATUS_LABEL[step.status]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
});
