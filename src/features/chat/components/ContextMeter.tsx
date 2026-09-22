// ============================================================
// Context Meter — Attributed Context Window Indicator
// ============================================================
// Shows the window as a segmented bar: who is spending the tokens
// (system prompt, tool schemas, compacted memory, conversation) and
// how much room is left. Hovering or focusing opens the breakdown
// card with exact provider counts from the last request, cache
// savings, and the conversation's running spend — the numbers other
// agent UIs surface and a single blended percentage cannot.
//
// The bar's denominator is the USABLE window (window − output
// reserve), so 100% means "compaction is due", not "the window is
// literally full".

import { AlertTriangle, Check } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { costShare, formatSpend, spendNote, shouldAttributeSpend } from "../lib/cost-meter";
import type { ContextBreakdown, ContextPart } from "../types";

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
  const denominator = Math.max(1, context.usableTokens);

  // Everything except free space is spend; free always closes the bar.
  const spendParts = context.parts.filter((p) => p.key !== "free");

  const label = (
    <span className={`chat-ctx-meter-label chat-ctx-health-${context.health}`}>
      {pct.toFixed(0)}%
    </span>
  );

  return (
    <SimpleTooltip
      side="bottom"
      className="chat-ctx-card"
      content={<ContextCard context={context} />}
    >
      <div
        className="chat-ctx-meter"
        role="status"
        tabIndex={0}
        aria-label={
          `Context window ${pct.toFixed(0)}% used — ` +
          `${formatTokens(context.totalTokens)} of ${formatTokens(context.usableTokens)} usable tokens. ` +
          "Focus for the breakdown."
        }
      >
        <div
          className={`chat-ctx-meter-track ${
            context.health === "exceeded" || context.health === "near-limit"
              ? "chat-ctx-meter-track-warn"
              : ""
          }`}
        >
          {spendParts.map((part) => (
            <span
              key={part.key}
              className={`chat-ctx-seg chat-ctx-seg-${part.key}`}
              style={{
                width: `${isZero ? 0 : Math.max(2, (part.tokens / denominator) * 100)}%`,
              }}
            />
          ))}
        </div>
        {label}
        {context.compactedTokens > 0 && (
          <span className="chat-ctx-compact-badge">compact</span>
        )}
      </div>
    </SimpleTooltip>
  );
}

/** The hover/focus card: attribution, exact counts, cache, spend. */
function ContextCard({ context }: { context: ContextBreakdown }) {
  const denominator = Math.max(1, context.usableTokens);
  // Spend rows first (fixed order), free space always closes the list.
  const freeRow = context.parts.find((p) => p.key === "free");
  const rows = [
    ...context.parts.filter((p) => p.key !== "free"),
    ...(freeRow ? [freeRow] : []),
  ];

  const cached = context.lastCachedTokens ?? 0;
  const cacheRatio =
    cached > 0 && context.lastPromptTokens
      ? Math.round((cached / context.lastPromptTokens) * 100)
      : 0;

  return (
    <div className="chat-ctx-card-inner">
      <div className="chat-ctx-card-head">
        <span className="chat-ctx-card-title">Context window</span>
        <span className={`chat-ctx-card-health chat-ctx-health-${context.health}`}>
          {HEALTH_LABEL[context.health]}
        </span>
      </div>

      <div className="chat-ctx-card-total">
        <strong>{formatTokens(context.totalTokens)}</strong> of{" "}
        {formatTokens(context.usableTokens)} usable tokens
        <span className="chat-ctx-card-sub">
          {formatTokens(context.maxTokens)} window ·{" "}
          {formatTokens(context.outputReserve)} reserved for the reply
        </span>
      </div>

      <div className="chat-ctx-card-rows">
        {rows.map((part) => (
          <ContextRow key={part.key} part={part} denominator={denominator} />
        ))}
      </div>

      <div className="chat-ctx-card-foot">
        {context.lastPromptTokens != null ? (
          <span className="chat-ctx-card-line">
            <Check className="h-3 w-3 chat-ctx-card-line-icon" />
            Last request sent{" "}
            <strong>{context.lastPromptTokens.toLocaleString()}</strong> tokens
            (exact)
          </span>
        ) : (
          <span className="chat-ctx-card-line">
            No request sent yet — these numbers are estimates.
          </span>
        )}

        {cached > 0 && (
          <span className="chat-ctx-card-line">
            <span className="chat-ctx-card-cache-dot" />
            <strong>{cached.toLocaleString()}</strong> of those were served from
            the prompt cache{context.lastPromptTokens ? ` (${cacheRatio}%)` : ""}{" "}
            — billed at a discount
          </span>
        )}

        {context.compactedTokens > 0 && (
          <span className="chat-ctx-card-line">
            <strong>{formatTokens(context.compactedTokens)}</strong> tokens of
            earlier history are folded into compacted memory
          </span>
        )}

        {context.totalCost > 0 && (
          <span className="chat-ctx-card-line">
            Conversation spend <strong>{formatSpend(context.totalCost)}</strong> ·{" "}
            {formatTokens(context.completionTokens)} tokens generated
          </span>
        )}

        {/* Who spent it. InTab routes work across models on purpose (a
            nested researcher, a vision check, an escalation), and a single
            blended total makes that routing look like a billing error. */}
        {context.spend && shouldAttributeSpend(context.spend) && (
          <div className="chat-ctx-spend">
            {context.spend.rows.slice(0, 4).map((row) => (
              <div key={row.modelId} className="chat-ctx-spend-row">
                <span
                  className="chat-ctx-spend-bar"
                  style={{ width: `${Math.max(2, costShare(row, context.spend!) * 100)}%` }}
                />
                <span className="chat-ctx-spend-model" title={row.modelId}>
                  {row.modelId}
                </span>
                <span className="chat-ctx-spend-val">
                  {formatSpend(row.cost)}
                  {row.calls > 1 ? ` · ${row.calls} replies` : ""}
                </span>
              </div>
            ))}
            {context.spend.rows.length > 4 && (
              <span className="chat-ctx-spend-note">
                +{context.spend.rows.length - 4} more model(s)
              </span>
            )}
          </div>
        )}

        {context.percentageUsed >= 70 && (
          <span className="chat-ctx-card-hint">
            <AlertTriangle className="h-3 w-3" />
            Older messages will be summarized before the next send — run{" "}
            <code>/compact</code> to free the room now.
          </span>
        )}

        {context.spend && spendNote(context.spend) && (
          <span className="chat-ctx-card-note">{spendNote(context.spend)}</span>
        )}

        <span className="chat-ctx-card-note">
          Estimated from stored history
          {context.calibrated
            ? " · corrected by this model's measured token ratio"
            : " · no measured ratio for this model yet"}
        </span>
      </div>
    </div>
  );
}

function ContextRow({
  part,
  denominator,
}: {
  part: ContextPart;
  denominator: number;
}) {
  const pctOfWindow = (part.tokens / denominator) * 100;
  return (
    <div
      className={`chat-ctx-row ${part.key === "free" ? "chat-ctx-row-free" : ""}`}
      title={part.detail}
    >
      <span className={`chat-ctx-dot chat-ctx-dot-${part.key}`} />
      <span className="chat-ctx-row-label">{part.label}</span>
      <span className="chat-ctx-row-val">{formatTokens(part.tokens)}</span>
      <span className="chat-ctx-row-pct">
        {pctOfWindow < 0.1 ? "<0.1" : pctOfWindow.toFixed(1)}%
      </span>
    </div>
  );
}
