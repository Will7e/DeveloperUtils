// ============================================================
// Context Meter — Live Context Window Usage Indicator
// ============================================================
// Renders estimated context usage for the active conversation with
// Geist health colors (green → amber → red). A 0% conversation
// shows an empty track instead of a phantom sliver.

import { SimpleTooltip } from "@/components/ui/tooltip";
import type { ContextBreakdown } from "../types";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const HEALTH_LABEL: Record<ContextBreakdown["health"], string> = {
  optimal: "Optimal",
  moderate: "Moderate",
  "near-limit": "Near limit",
  exceeded: "Compacting on next send",
};

export function ContextMeter({ context }: { context: ContextBreakdown }) {
  const pct = Math.min(100, context.percentageUsed);
  const isZero = pct < 0.5;
  const colorClass =
    isZero
      ? "chat-ctx-meter-fill-zero"
      : context.health === "exceeded"
        ? "chat-ctx-meter-fill-exceeded"
        : context.health === "near-limit"
          ? "chat-ctx-meter-fill-near"
          : context.health === "moderate"
            ? "chat-ctx-meter-fill-moderate"
            : "chat-ctx-meter-fill-optimal";

  const compacted = context.compactedTokens > 0;

  return (
    <SimpleTooltip
      content={
        <>
          {formatTokens(context.totalTokens)} of {formatTokens(context.maxTokens)} tokens ·{" "}
          {HEALTH_LABEL[context.health]}
          {compacted && (
            <>
              <br />
              {formatTokens(context.compactedTokens)} tokens summarized into compacted
              memory
            </>
          )}
        </>
      }
      side="bottom"
    >
      <div
        className="chat-ctx-meter"
        role="status"
        aria-label={`Context window ${pct.toFixed(0)}% used`}
      >
        <div className="chat-ctx-meter-track">
          <div
            className={`chat-ctx-meter-fill ${colorClass}`}
            style={{ width: `${isZero ? 0 : Math.max(2, pct)}%` }}
          />
        </div>
        <span className="chat-ctx-meter-label">{pct.toFixed(0)}%</span>
        {compacted && <span className="chat-ctx-compact-badge">compact</span>}
      </div>
    </SimpleTooltip>
  );
}
