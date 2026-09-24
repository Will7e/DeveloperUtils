import { describe, expect, it } from "vitest";
import {
  classifyOpenRouterError,
  isTerminalFailure,
  retryDelayMs,
} from "./openrouter-error-taxonomy";
import errorsFixture from "./__fixtures__/errors.json";

// ============================================================
// Error Taxonomy — Classification Tests
// ============================================================
// Split into two honesty tiers:
//
//   "observed"   — driven by `__fixtures__/errors.json`, captured verbatim from
//                  the live API by `npm run probe:openrouter`. These can only
//                  be obtained for free (a 401, a 400, a 404).
//   "documented" — the envelopes that require a real inference request to see
//                  (the in-flight-budget 402, a guardrail 403, provider
//                  errors). They are written from OpenRouter's published
//                  shapes and marked as such, so nobody later mistakes a
//                  documented shape for a measured one.

describe("fixture-backed classification (observed shapes)", () => {
  it("reads the 401 envelope as an auth failure, keeping the provider's words", () => {
    const failure = classifyOpenRouterError({
      status: 401,
      body: errorsFixture.unauthorized,
    });
    expect(failure.kind).toBe("auth");
    // The upstream message is `User not found.` — kept, because a paraphrase
    // cannot be grepped and this one carries no secret.
    expect(failure.message).toMatch(/User not found/);
    expect(failure.message).toMatch(/Chat Settings/);
    expect(failure.retryable).toBe(false);
    expect(isTerminalFailure(failure)).toBe(true);
  });

  it("reads the 400 envelope as a payload failure and quotes it verbatim", () => {
    const failure = classifyOpenRouterError({
      status: 400,
      body: errorsFixture.badRequest,
    });
    expect(failure.kind).toBe("payload");
    // A malformed-request message is the user's only lead, so it must survive
    // classification rather than being replaced by a generic sentence.
    expect(failure.message).toBe('Input required: specify "prompt" or "messages"');
    expect(failure.retryable).toBe(false);
  });

  it("reads the 404 envelope as not-found and still says to switch models", () => {
    const failure = classifyOpenRouterError({
      status: 404,
      body: errorsFixture.notFound,
    });
    expect(failure.kind).toBe("not-found");
    expect(failure.message).toMatch(/not-a-real-model/);
    expect(failure.retryable).toBe(false);
  });

  it("never proposes a retry for a terminal billing or auth problem", () => {
    for (const [status, body] of [
      [401, errorsFixture.unauthorized],
      [400, errorsFixture.badRequest],
    ] as const) {
      expect(
        classifyOpenRouterError({ status, body }).retryable
      ).toBe(false);
    }
  });
});

describe("402 — three causes behind one status", () => {
  it("says plainly that an in-flight budget limit is not a credits problem", () => {
    // The bug this replaces: every 402 was reported as "your account is out of
    // credits", which sends someone to the top-up page to fix a problem money
    // cannot solve.
    const failure = classifyOpenRouterError({
      status: 402,
      retryAfterSeconds: 12,
      body: {
        error: {
          code: 402,
          message: "In-flight budget exhausted",
          metadata: {
            reason: "in_flight_budget_exhausted",
            limit_source: "openrouter_in_flight_budget",
            remedy_hint: "Wait for in-flight requests to complete, then retry.",
          },
        },
      },
    });
    expect(failure.kind).toBe("in-flight-budget");
    expect(failure.limitSource).toBe("openrouter_in_flight_budget");
    expect(failure.message).toMatch(/not a balance problem/i);
    expect(failure.message).toMatch(/do not need to add credits/i);
    // The wait is the documented remedy, so it must be both stated and honoured.
    expect(failure.message).toMatch(/12s/);
    expect(failure.retryable).toBe(true);
    expect(retryDelayMs(failure)).toBe(12_000);
  });

  it("distinguishes the key's own credit cap from the account balance", () => {
    const keyLimited = classifyOpenRouterError({
      status: 402,
      body: {
        error: {
          code: 402,
          message: "Key limit exceeded",
          metadata: { limit_source: "openrouter_key_limit" },
        },
      },
    });
    expect(keyLimited.kind).toBe("out-of-credits");
    expect(keyLimited.message).toMatch(/key's own credit limit/i);
    expect(keyLimited.retryable).toBe(false);

    const account = classifyOpenRouterError({
      status: 402,
      body: { error: { code: 402, metadata: { limit_source: "openrouter_credits" } } },
    });
    expect(account.message).toMatch(/balance/i);
    expect(account.retryable).toBe(false);
  });

  it("names both possible causes when the body does not say which (documented)", () => {
    const failure = classifyOpenRouterError({
      status: 402,
      body: { error: { code: 402, message: "Payment required" } },
    });
    expect(failure.kind).toBe("out-of-credits");
    // Guessing here is what produced the wrong advice before, so the message
    // admits both and points at activity rather than the checkout page.
    expect(failure.message).toMatch(/either/i);
    expect(failure.message).toMatch(/activity/i);
  });
});

describe("403 — content problems are not permission problems", () => {
  it("reads a guardrail block as a guardrail block, naming the patterns", () => {
    const failure = classifyOpenRouterError({
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Request blocked by guardrail",
          metadata: { patterns: ["credit_card", "ssn"] },
        },
      },
    });
    expect(failure.kind).toBe("guardrail");
    expect(failure.patterns).toEqual(["credit_card", "ssn"]);
    expect(failure.message).toMatch(/“credit_card”/);
    expect(failure.message).toMatch(/guardrail/i);
    expect(failure.retryable).toBe(false);
  });

  it("reads a moderation flag as moderation and quotes the flagged excerpt", () => {
    const failure = classifyOpenRouterError({
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Input flagged",
          metadata: {
            reasons: ["violence"],
            flagged_input: "…some flagged excerpt…",
            provider_name: "SomeProvider",
            model_slug: "vendor/model",
          },
        },
      },
    });
    expect(failure.kind).toBe("moderation");
    expect(failure.patterns).toEqual(["violence"]);
    expect(failure.flaggedInput).toContain("flagged excerpt");
    expect(failure.message).toMatch(/moderation/i);
  });

  it("falls back to a permissions answer only when the body names nothing", () => {
    const failure = classifyOpenRouterError({
      status: 403,
      body: { error: { code: 403, message: "Forbidden" } },
    });
    expect(failure.kind).toBe("forbidden");
    expect(failure.message).toMatch(/guardrail|moderation|permission/i);
  });
});

describe("retry policy follows the response, not a fixed guess", () => {
  it("treats transport failures as retryable and says so without a status", () => {
    const failure = classifyOpenRouterError({ status: 0 });
    expect(failure.kind).toBe("offline");
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/connection/i);
  });

  it("honours Retry-After on a throttle", () => {
    const failure = classifyOpenRouterError({ status: 429, retryAfterSeconds: 30 });
    expect(failure.kind).toBe("rate-limit");
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/30s/);
    expect(retryDelayMs(failure)).toBe(30_000);
  });

  it("caps the wait so a hostile header cannot park the turn", () => {
    const failure = classifyOpenRouterError({ status: 429, retryAfterSeconds: 3600 });
    // A provider is free to ask for an hour; the app still has to stay usable,
    // so the wait is clamped rather than obeyed literally.
    expect(retryDelayMs(failure)).toBe(120_000);
  });

  it("falls back to a modest delay when no header was sent", () => {
    const failure = classifyOpenRouterError({ status: 503 });
    expect(failure.kind).toBe("provider-down");
    expect(retryDelayMs(failure)).toBe(2000);
    expect(retryDelayMs(failure, 500)).toBe(500);
  });

  it("recognises a transient typed code on a status that is not usually retryable", () => {
    // The vocabulary is OpenRouter's, so a 400 carrying an explicit
    // `rate_limit_exceeded` is trusted over the status alone.
    const failure = classifyOpenRouterError({
      status: 400,
      body: { error: { code: 400, metadata: { error_type: "rate_limit_exceeded" } } },
    });
    expect(failure.errorType).toBe("rate_limit_exceeded");
    expect(failure.retryable).toBe(true);
  });

  it("does not invent a retry for an unknown typed code", () => {
    const failure = classifyOpenRouterError({
      status: 400,
      body: { error: { code: 400, metadata: { error_type: "something_new" } } },
    });
    expect(failure.retryable).toBe(false);
  });

  it("masks nothing it cannot verify: a 500 is described without quoting internals", () => {
    const failure = classifyOpenRouterError({
      status: 500,
      body: { error: { code: 500, message: "Internal Server Error" } },
    });
    expect(failure.kind).toBe("server");
    expect(failure.retryable).toBe(true);
    expect(failure.message).toMatch(/internal error/i);
  });
});

describe("robustness against bodies that are not what they claim", () => {
  it("survives a body that is not JSON at all", () => {
    const failure = classifyOpenRouterError({ status: 502, body: "<html>502</html>" });
    expect(failure.kind).toBe("provider-down");
    expect(failure.message).toMatch(/provider/i);
  });

  it("survives a body that is a bare string", () => {
    const failure = classifyOpenRouterError({ status: 404, body: "not found" });
    expect(failure.kind).toBe("not-found");
  });

  it("survives a nested error that is a string rather than an object", () => {
    const failure = classifyOpenRouterError({ status: 400, body: { error: "bad input" } });
    expect(failure.kind).toBe("payload");
  });

  it("ignores an unusable Retry-After instead of waiting NaN milliseconds", () => {
    const failure = classifyOpenRouterError({ status: 429, retryAfterSeconds: NaN });
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(retryDelayMs(failure)).toBe(2000);
  });

  it("drops empty pattern lists rather than claiming a guardrail matched nothing", () => {
    const failure = classifyOpenRouterError({
      status: 403,
      body: { error: { code: 403, metadata: { patterns: [] } } },
    });
    expect(failure.kind).toBe("forbidden");
    expect(failure.patterns).toBeUndefined();
  });

  it("keeps the provider's own error code when it was not masked", () => {
    const failure = classifyOpenRouterError({
      status: 503,
      body: {
        error: {
          code: 503,
          message: "Provider unavailable",
          metadata: { error_type: "provider_overloaded", provider_code: "overloaded_1001" },
        },
      },
    });
    expect(failure.providerCode).toBe("overloaded_1001");
    expect(failure.errorType).toBe("provider_overloaded");
    expect(failure.retryable).toBe(true);
  });
});
