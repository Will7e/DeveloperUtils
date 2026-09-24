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
import {
  cacheReadRate,
  costShare,
  formatSpend,
  spendNote,
  shouldAttributeSpend,
} from "../lib/cost-meter";
import { REASONING_EFFORT_META } from "../lib/model-state";
import { endpointNotes, type EndpointSummary } from "../lib/model-endpoints";
import type { ChatMode, ContextBreakdown, ContextPart, ReasoningEffort } from "../types";

/**
 * The session behind the numbers: what is answering, how hard it thinks and
 * what it may do. These lived in two places that could disagree — a status
 * read-out and the header pickers — so they are stated once here, beside the
 * window they explain.
 */
export interface ContextSessionReadout {
  /** Exact model id (the picker shows a display name, not the id) */
  model: string;
  effort: ReasoningEffort;
  mode: ChatMode;
}

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

export function ContextMeter({
  context,
  session,
  endpoints,
}: {
  context: ContextBreakdown;
  session?: ContextSessionReadout;
  /**
   * Who serves the selected model, when it is known.
   *
   * Sits beside the session readout because it explains the session: the same
   * id is served by several providers at different prices, with different
   * parameter support and their own caching behaviour, and the header names the
   * id while only this can say what will actually answer it.
   */
  endpoints?: EndpointSummary | null;
}) {
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
      content={<ContextCard context={context} session={session} endpoints={endpoints} />}
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
function ContextCard({
  context,
  session,
  endpoints,
}: {
  context: ContextBreakdown;
  session?: ContextSessionReadout;
  endpoints?: EndpointSummary | null;
}) {
  // Only worth stating when a tool turn can actually be routed somewhere, and
  // only for the facts that are unusual — see `endpointNotes`.
  const servingNotes = endpoints ? endpointNotes(endpoints, { toolRequirement: true }) : [];
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

      {session && (
        <div className="chat-ctx-card-session">
          <span className="chat-ctx-card-session-model" title={session.model}>
            {session.model}
          </span>
          <span className="chat-ctx-card-session-sep">·</span>
          <span>effort {REASONING_EFFORT_META[session.effort].label.toLowerCase()}</span>
          <span className="chat-ctx-card-session-sep">·</span>
          <span>{session.mode} mode</span>
        </div>
      )}

      {/* What serves it. The cheapest endpoint is named because that is the
          app's whole premise — routing to the cheapest capable provider — and
          the spread is stated when it is large enough to matter. */}
      {endpoints && endpoints.endpoints > 0 && (
        <div className="chat-ctx-serving">
          <span className="chat-ctx-serving-line">
            Served by <strong>{endpoints.providers}</strong>{" "}
            {endpoints.providers === 1 ? "provider" : "providers"}
            {endpoints.endpoints > endpoints.providers
              ? ` (${endpoints.endpoints} services)`
              : ""}
            {endpoints.cheapest && (
              <>
                {" · cheapest "}
                <strong title={endpoints.cheapest.providerName}>
                  {endpoints.cheapest.providerName}
                  {endpoints.cheapest.tag ? ` ${endpoints.cheapest.tag}` : ""}
                </strong>{" "}
                at ${endpoints.cheapest.promptPrice.toFixed(2)}/M in
              </>
            )}
            {endpoints.fastestP50Ms !== undefined && (
              <> · quickest {(endpoints.fastestP50Ms / 1000).toFixed(1)}s to first token</>
            )}
          </span>
          {servingNotes.map((note) => (
            <span key={note} className="chat-ctx-serving-note">
              {note}
            </span>
          ))}
        </div>
      )}

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

        {/* The conversation's cache rate, not this reply's. Any single reply can
            show a hit; only the aggregate says whether the cacheable prefix is
            actually being reused, which is the number that catches a prefix that
            quietly stopped matching. */}
        {context.spend && cacheReadRate(context.spend) !== null && (
          <span className="chat-ctx-card-line">
            <span className="chat-ctx-card-cache-dot" />
            Across this conversation, <strong>{Math.round(cacheReadRate(context.spend)! * 100)}%</strong>{" "}
            of prompt tokens ({formatTokens(context.spend.cachedTokens)}) were cache
            reads — the rest were sent fresh
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
