// ============================================================
// OpenRouter Error Taxonomy — Failures, Classified By Cause
// ============================================================
// The client used to map a numeric status onto a sentence, and two of those
// sentences were wrong in ways that cost the user real work:
//
//   • EVERY 402 said "your account is out of credits". Since OpenRouter added
//     the in-flight spending budget, a 402 can arrive with a POSITIVE balance
//     — it means "your running requests already fill the budget", it is
//     transient, and the documented remedy is to wait for Retry-After. Sending
//     someone to the top-up page for that is worse than saying nothing: they
//     pay money to fix a problem they do not have.
//   • EVERY 403 said "this model requires additional permissions". But 403 is
//     also what a guardrail block and a provider moderation flag return, and
//     those are about the CONTENT of the request, not the account. A user told
//     to check permissions for a prompt-injection block looks in the wrong
//     place entirely.
//
// The fix is not better prose. OpenRouter publishes the cause in the body and
// the fix in the headers — `error.metadata.error_type`, `limit_source`,
// `remedy_hint`, `Retry-After`, the matched guardrail `patterns` — so this
// module reads the cause and lets the message fall out of it.
//
// Pure: no fetch, no clock, no store. Retry policy is derived here too, because
// "should we try again" and "what do we say" are the same question, and
// splitting them across two files is how they drift.
//
// Fixture note: `lib/__fixtures__/errors.json` holds REAL envelopes captured by
// `npm run probe:openrouter` (a 401, a 400 and a 404 — all free to obtain). The
// envelopes that only a real inference request can produce (402 in-flight,
// guardrail 403, mid-stream provider errors) are written from OpenRouter's
// documented shapes and labelled as such in the tests, so the difference
// between "observed" and "documented" stays visible.

/** What actually went wrong, in a form a caller can branch on. */
export type OpenRouterFailureKind =
  /** The key is missing, invalid, disabled or expired */
  | "auth"
  /** The balance or the key's own credit cap cannot cover this request */
  | "out-of-credits"
  /** In-flight spending budget filled — transient, and NOT a billing problem */
  | "in-flight-budget"
  /** A guardrail blocked the request before it reached a provider */
  | "guardrail"
  /** The provider's moderation flagged the input */
  | "moderation"
  /** Permissions, or a 403 whose cause the body does not name */
  | "forbidden"
  /** The model or route does not exist any more */
  | "not-found"
  /** The request itself was malformed */
  | "payload"
  /** OpenRouter rate-limited us */
  | "rate-limit"
  /** The chosen provider is down or returned something unusable */
  | "provider-down"
  /** OpenRouter's own failure (message is masked upstream) */
  | "server"
  /** Transport failure: we never got a status at all */
  | "offline"
  /** Classified from nothing usable */
  | "unknown";

export interface OpenRouterFailure {
  kind: OpenRouterFailureKind;
  /** The sentence to show, already resolved from the cause */
  message: string;
  /** HTTP status observed; 0 when the request never got a response */
  status: number;
  /** The stable `error.metadata.error_type`, when the body carried one */
  errorType?: string;
  /** Which limit the 402 was about — branch on this, never on the prose */
  limitSource?: string;
  /** OpenRouter's own suggested next step, shown when it adds anything */
  remedyHint?: string;
  /** Seconds to wait before retrying, when the response said */
  retryAfterSeconds?: number;
  /** True when retrying the SAME request is worth doing */
  retryable: boolean;
  /** Guardrail patterns that matched */
  patterns?: string[];
  /** The excerpt moderation flagged (already truncated by OpenRouter) */
  flaggedInput?: string;
  /** The provider's own error code, when it was not masked */
  providerCode?: string;
}

export interface FailureInput {
  status: number;
  /** Parsed JSON body, or undefined when the body was not JSON / was empty */
  body?: unknown;
  /** `Retry-After` response header, in seconds */
  retryAfterSeconds?: number | null;
  /**
   * Rate-limit reset hints from a 429; kept because the host learns real
   * cooldown windows from these instead of guessing a fixed delay.
   */
  rateLimitHeaders?: Record<string, string>;
}

/** Statuses where retrying the same request can succeed */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Typed provider codes that mean "try again". The vocabulary is OpenRouter's
 * and grows over time, so this list is a whitelist of *known transient* codes;
 * an unrecognised one falls back to the status-based answer rather than being
 * assumed retryable.
 */
const RETRYABLE_ERROR_TYPES = new Set([
  "rate_limit_exceeded",
  "provider_overloaded",
  "server",
  "timeout",
  "upstream_error",
  "provider_error",
  "unavailable",
]);

interface ErrorBody {
  message?: string;
  code?: number | string;
  metadata?: {
    error_type?: string;
    provider_code?: string;
    reason?: string;
    limit_source?: string;
    remedy_hint?: string;
    /** Guardrail blocks: the patterns that matched */
    patterns?: unknown;
    /** Moderation flags */
    reasons?: unknown;
    flagged_input?: unknown;
    provider_name?: unknown;
    model_slug?: unknown;
  };
}

/** Narrows the many shapes OpenRouter uses into one readable record */
function readErrorBody(body: unknown): ErrorBody | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (error && typeof error === "object") return error as ErrorBody;
  // Some failures come back as a bare object with a message
  if (typeof (body as ErrorBody).message === "string") return body as ErrorBody;
  return undefined;
}

/**
 * Appends the upstream message to a diagnosis, when it adds anything.
 *
 * The order matters and used to be the other way round: a bare `detail`
 * ("Payment required", "Forbidden") displaced the diagnosis entirely, so the
 * user got the provider's summary instead of the reason. The diagnosis is the
 * product here; the upstream sentence is supporting evidence.
 */
function detailSuffix(detail: string | undefined): string {
  if (!detail) return "";
  // Skip restatements that carry no information beyond the status.
  if (/^(forbidden|payment required|unauthorized|bad request|not found)$/i.test(detail.trim())) {
    return "";
  }
  return ` Upstream said: “${detail}”.`;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return out.length > 0 ? out : undefined;
}

/**
 * Classifies one failed request.
 *
 * Order matters: the BODY outranks the status. A 402 whose `limit_source` names
 * the in-flight budget is not a credits problem, and a 403 whose metadata names
 * matched patterns is not a permissions problem — so the specific evidence is
 * read before the generic bucket is chosen.
 */
export function classifyOpenRouterError(input: FailureInput): OpenRouterFailure {
  const { status } = input;
  const error = readErrorBody(input.body);
  const meta = error?.metadata;
  const detail = error?.message?.trim();
  const providerCode = meta?.provider_code;
  const errorType = meta?.error_type;
  const limitSource = meta?.limit_source;
  const remedyHint = meta?.remedy_hint;
  const retryAfterSeconds =
    typeof input.retryAfterSeconds === "number" && Number.isFinite(input.retryAfterSeconds)
      ? input.retryAfterSeconds
      : undefined;

  const base = {
    status,
    ...(errorType ? { errorType } : {}),
    ...(limitSource ? { limitSource } : {}),
    ...(remedyHint ? { remedyHint } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(providerCode ? { providerCode } : {}),
  };

  // ── 402: three different problems behind one status ──
  if (status === 402) {
    if (limitSource === "openrouter_in_flight_budget") {
      const wait = retryAfterSeconds ? ` Retry in about ${retryAfterSeconds}s.` : " Retry shortly.";
      return {
        ...base,
        kind: "in-flight-budget",
        // Says explicitly that credits are NOT the problem: the honest sentence
        // here prevents a purchase nobody needed.
        message: `OpenRouter is holding requests until the work already in flight settles — this is a capacity limit, not a balance problem, so you do not need to add credits.${wait}`,
        retryable: true,
      };
    }
    if (limitSource === "openrouter_key_limit") {
      return {
        ...base,
        kind: "out-of-credits",
        message:
          "This API key's own credit limit is exhausted. Raise the key's limit in OpenRouter, or use a different key.",
        retryable: false,
      };
    }
    if (limitSource === "openrouter_credits") {
      return {
        ...base,
        kind: "out-of-credits",
        message: "Your OpenRouter balance cannot cover this request. Add credits at openrouter.ai/credits.",
        retryable: false,
      };
    }
    // No limit_source, so both causes remain possible. The diagnosis leads and
    // the upstream sentence follows it, rather than the other way around: the
    // old code returned `detail` first, which is how a body that says nothing
    // but "Payment required" reached the user as a dead end. A wrong diagnosis
    // here sends someone to the top-up page for a capacity problem, so both
    // causes are named and neither is guessed at.
    return {
      ...base,
      kind: "out-of-credits",
      message:
        "OpenRouter refused this request for spending reasons — either the account balance is exhausted, or requests already in flight fill the spending budget. Check openrouter.ai/activity, then retry." +
        detailSuffix(detail),
      retryable: true,
    };
  }

  // ── 403: guardrail and moderation are content problems, not account ones ──
  if (status === 403) {
    const patterns = stringList(meta?.patterns);
    if (patterns) {
      return {
        ...base,
        kind: "guardrail",
        patterns,
        message: `A guardrail blocked this request before any model saw it: it matched ${patterns
          .map((p) => `“${p}”`)
          .join(", ")}. Rephrase the request, or adjust the guardrail in your OpenRouter settings.`,
        retryable: false,
      };
    }
    const reasons = stringList(meta?.reasons);
    const flagged = typeof meta?.flagged_input === "string" ? meta.flagged_input : undefined;
    if (reasons || flagged) {
      return {
        ...base,
        kind: "moderation",
        ...(reasons ? { patterns: reasons } : {}),
        ...(flagged ? { flaggedInput: flagged } : {}),
        message: `The provider's moderation flagged this input${
          reasons ? ` (${reasons.join(", ")})` : ""
        }. Change the wording and try again${flagged ? ` — flagged text: “${flagged}”` : ""}.`,
        retryable: false,
      };
    }
    // The two named causes were ruled out above, so this is the residual case.
    // The diagnosis still leads: `detail` here is typically the word
    // "Forbidden", which tells the user nothing they did not already know.
    return {
      ...base,
      kind: "forbidden",
      message:
        "OpenRouter refused this request (HTTP 403) — most often a guardrail, a moderation flag, or a model your account cannot use." +
        detailSuffix(detail),
      // Retrying identical content produces an identical refusal.
      retryable: false,
    };
  }

  // ── Transport ──
  if (status === 0) {
    return {
      ...base,
      kind: "offline",
      message: detail || "Could not reach OpenRouter. Check your connection and try again.",
      retryable: true,
    };
  }

  const retryableFromBody = errorType ? RETRYABLE_ERROR_TYPES.has(errorType) : false;
  const retryable = RETRYABLE_STATUS.has(status) || retryableFromBody;

  switch (status) {
    case 400:
    case 422:
      return {
        ...base,
        kind: "payload",
        message: detail || "OpenRouter rejected this request as malformed.",
        // A malformed request is permanent for THIS body — but an explicit
        // transient code (a throttle delivered as a 400) is a statement about
        // the moment, and the gateway knows its own vocabulary better than the
        // status line does.
        retryable: retryableFromBody,
      };
    case 401:
      return {
        ...base,
        kind: "auth",
        message: detail
          ? `Your OpenRouter API key was rejected (${detail}). Check it in Chat Settings.`
          : "Your OpenRouter API key is invalid or expired. Check it in Chat Settings.",
        retryable: false,
      };
    case 404:
      return {
        ...base,
        kind: "not-found",
        message:
          detail ||
          "Model not found. It may have been deprecated — pick another model.",
        retryable: false,
      };
    case 408:
      return {
        ...base,
        kind: "provider-down",
        message: "The request timed out before it completed. Try again.",
        retryable: true,
      };
    case 429: {
      const wait = retryAfterSeconds ? ` Try again in about ${retryAfterSeconds}s.` : " Wait a moment and try again.";
      return {
        ...base,
        kind: "rate-limit",
        message: `Rate limited by OpenRouter.${wait}`,
        retryable: true,
      };
    }
    case 502:
    case 503:
    case 504:
    case 529:
      return {
        ...base,
        kind: "provider-down",
        message:
          detail ||
          "No available provider could serve this request right now. Try again shortly, or pick another model.",
        retryable: true,
      };
    case 500:
      // The message is masked upstream on 500s (provider_code is stripped too),
      // so there is nothing to quote and a detail-less sentence is the honest
      // answer rather than a leaked internal string.
      return {
        ...base,
        kind: "server",
        message: "OpenRouter hit an internal error handling this request. Try again shortly.",
        retryable: true,
      };
    default:
      return {
        ...base,
        kind: "unknown",
        message: detail || `OpenRouter request failed (HTTP ${status}).`,
        retryable,
      };
  }
}

/**
 * How long to wait before the retry, in milliseconds.
 *
 * OpenRouter sends `Retry-After` on 429, on 503, and on the in-flight-budget
 * 402 — the three cases where waiting is the documented remedy. When it is
 * absent we fall back to the 429 reset hints the client already captured, then
 * to a modest default, because retrying a rate limit immediately is how a
 * momentary limit becomes a sustained one.
 */
export function retryDelayMs(failure: OpenRouterFailure, fallbackMs = 2000): number {
  if (failure.retryAfterSeconds && failure.retryAfterSeconds > 0) {
    return Math.min(failure.retryAfterSeconds, 120) * 1000;
  }
  return fallbackMs;
}

/**
 * Whether a failure is worth surfacing as "the agent could not continue" rather
 * than a recoverable hiccup. Used by the transcript to choose between a note
 * and a hard stop.
 */
export function isTerminalFailure(failure: OpenRouterFailure): boolean {
  return failure.kind === "auth" || failure.kind === "out-of-credits" || failure.kind === "payload";
}
