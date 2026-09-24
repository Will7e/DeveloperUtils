// ============================================================
// Model Endpoints — what actually serves the model you picked
// ============================================================
// A model id is a promise about a model; an endpoint is the thing that answers.
// The catalog describes the promise (a price, a window, a parameter list), and
// every one of those is an average over the endpoints — so the catalog is the
// right thing to choose a model WITH and the wrong thing to reason about the
// turn with.
//
// What the endpoint list knows that nothing else does, in the order it matters
// to this app:
//
//   1. Whether the prompt cache can work at all. `supports_implicit_caching`
//      and a per-endpoint `input_cache_read` rate are the provider's answer, and
//      the capture this was built from has providers that report false — so
//      "we send a stable prefix" and "the prefix gets cached" are two different
//      claims, and only the second one saves money.
//   2. Whether a tool turn is even routable. `supported_parameters` is per
//      ENDPOINT, which is what `provider.require_parameters` filters on: a model
//      whose every endpoint omits `tools` will fail a tool request rather than
//      quietly answering in prose. That is a fact worth showing BEFORE the turn.
//   3. Which provider is. Same id, measured spread: 2.2× on prompt price and
//      3.5× on p50 latency between endpoints of one model.
//
// Pure, so all of it is unit-tested against a captured response rather than
// observed in a running app.

import type { ModelEndpointInfo } from "../types";

/** The wire shape of `GET /models/{author}/{slug}/endpoints` */
export interface EndpointsPayload {
  data?: {
    id?: string;
    endpoints?: EndpointRecord[];
  };
}

// Every numeric field here is `| null` as well as optional, because the API uses
// both spellings for "no value": the captured fixture has endpoints with
// `max_prompt_tokens: null` and others with the key absent. Typing only the
// absent case is what a fixture catches and a doc skim does not.
interface EndpointRecord {
  provider_name?: string;
  tag?: string;
  context_length?: number | null;
  max_prompt_tokens?: number | null;
  max_completion_tokens?: number | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
  };
  quantization?: string;
  supported_parameters?: string[];
  supports_implicit_caching?: boolean;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  latency_last_30m?: { p50?: number } | null;
  throughput_last_30m?: { p50?: number } | null;
}

/** `"0.0000001"` (USD per token) → `0.1` (USD per million) */
function perMillion(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value * 1_000_000 : undefined;
}

function numberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses an endpoints response into records.
 *
 * Tolerant on purpose, in one direction only: a record missing its provider name
 * is DROPPED rather than kept as an anonymous entry, because every claim below
 * ("the cheapest provider", "three of them cache") is a claim about a named
 * provider, and an unnamed row would quietly inflate the counts.
 */
export function parseEndpointRecords(payload: EndpointsPayload | undefined): ModelEndpointInfo[] {
  const records = payload?.data?.endpoints;
  if (!Array.isArray(records)) return [];

  const out: ModelEndpointInfo[] = [];
  for (const record of records) {
    const providerName = record?.provider_name?.trim();
    if (!providerName) continue;
    const promptPrice = perMillion(record.pricing?.prompt);
    const completionPrice = perMillion(record.pricing?.completion);
    const cacheReadPrice = perMillion(record.pricing?.input_cache_read);
    out.push({
      providerName,
      ...(record.tag?.trim() ? { tag: record.tag.trim() } : {}),
      ...(numberOrUndefined(record.context_length) !== undefined
        ? { contextLength: numberOrUndefined(record.context_length) }
        : {}),
      ...(numberOrUndefined(record.max_prompt_tokens) !== undefined
        ? { maxPromptTokens: numberOrUndefined(record.max_prompt_tokens) }
        : {}),
      ...(numberOrUndefined(record.max_completion_tokens) !== undefined
        ? { maxCompletionTokens: numberOrUndefined(record.max_completion_tokens) }
        : {}),
      ...(promptPrice !== undefined ? { promptPrice } : {}),
      ...(completionPrice !== undefined ? { completionPrice } : {}),
      ...(cacheReadPrice !== undefined ? { cacheReadPrice } : {}),
      ...(record.quantization && record.quantization !== "unknown"
        ? { quantization: record.quantization }
        : {}),
      ...(Array.isArray(record.supported_parameters)
        ? { supportedParameters: record.supported_parameters }
        : {}),
      ...(record.supports_implicit_caching === true ? { supportsImplicitCaching: true } : {}),
      ...(numberOrUndefined(record.uptime_last_5m) !== undefined
        ? { uptimeLast5m: numberOrUndefined(record.uptime_last_5m) }
        : {}),
      ...(numberOrUndefined(record.uptime_last_30m) !== undefined
        ? { uptimeLast30m: numberOrUndefined(record.uptime_last_30m) }
        : {}),
      ...(numberOrUndefined(record.latency_last_30m?.p50) !== undefined
        ? { latencyP50: numberOrUndefined(record.latency_last_30m?.p50) }
        : {}),
      ...(numberOrUndefined(record.throughput_last_30m?.p50) !== undefined
        ? { throughputP50: numberOrUndefined(record.throughput_last_30m?.p50) }
        : {}),
    });
  }
  return out;
}

/** What the endpoint list says about serving this model, in one object */
export interface EndpointSummary {
  /** Distinct providers (an endpoint is a provider × service tier) */
  providers: number;
  /** Provider services, i.e. the number of ways this model can be routed */
  endpoints: number;
  /** The cheapest endpoint by prompt price, when one is priced */
  cheapest?: { providerName: string; tag?: string; promptPrice: number };
  /** Spread across endpoints that publish a prompt price (max / min) */
  priceSpread?: number;
  /** Latency of the quickest endpoint with a measured p50 (ms) */
  fastestP50Ms?: number;
  /** Endpoints declaring `tools` support — what a tool turn can route to */
  toolEndpoints: number;
  /** Endpoints whose provider caches implicitly, and how many publish a rate to read it */
  implicitCachingEndpoints: number;
  cachePricedEndpoints: number;
}

/** Distinct providers, and whether this model can be routed around a failure */
export function summarizeEndpoints(endpoints: readonly ModelEndpointInfo[]): EndpointSummary {
  const providers = new Set(endpoints.map((e) => e.providerName));
  const priced = endpoints.filter(
    (e): e is ModelEndpointInfo & { promptPrice: number } => typeof e.promptPrice === "number"
  );
  const cheapest = priced.reduce<EndpointSummary["cheapest"]>((best, e) => {
    if (!best || e.promptPrice < best.promptPrice) {
      return {
        providerName: e.providerName,
        ...(e.tag ? { tag: e.tag } : {}),
        promptPrice: e.promptPrice,
      };
    }
    return best;
  }, undefined);

  const prices = priced.map((e) => e.promptPrice);
  const min = prices.length > 0 ? Math.min(...prices) : undefined;
  const max = prices.length > 0 ? Math.max(...prices) : undefined;
  // Only a spread when there is something to compare — one provider at one price
  // has no spread, and reporting 1× would imply a comparison that was not made.
  const priceSpread =
    min !== undefined && max !== undefined && min > 0 && max > min ? max / min : undefined;

  const latencies = endpoints
    .map((e) => e.latencyP50)
    .filter((v): v is number => typeof v === "number" && v > 0);

  return {
    providers: providers.size,
    endpoints: endpoints.length,
    ...(cheapest ? { cheapest } : {}),
    ...(priceSpread !== undefined ? { priceSpread } : {}),
    ...(latencies.length > 0 ? { fastestP50Ms: Math.min(...latencies) } : {}),
    toolEndpoints: endpoints.filter((e) => e.supportedParameters?.includes("tools")).length,
    implicitCachingEndpoints: endpoints.filter((e) => e.supportsImplicitCaching).length,
    cachePricedEndpoints: endpoints.filter((e) => typeof e.cacheReadPrice === "number").length,
  };
}

/**
 * The facts worth stating about this model's endpoints, as short lines.
 *
 * Ordered by what a user should act on, and deliberately silent about anything
 * that is not unusual: a model served by three providers that all support tools
 * and all publish a cache rate produces one sentence, not five — the whole point
 * of showing serving facts is that they are evidence, and evidence that is
 * always present stops being read.
 *
 * `toolRequirement` is passed in rather than assumed: the warning only makes
 * sense for a request that will actually assert it (see lib/provider-routing.ts).
 */
export function endpointNotes(
  summary: EndpointSummary,
  options: { toolRequirement: boolean }
): string[] {
  const notes: string[] = [];

  // ── 1. The one that can fail a turn ──
  if (options.toolRequirement && summary.toolEndpoints === 0) {
    notes.push(
      "No endpoint of this model declares tool support, so a tool turn cannot be routed to it " +
        "and will fail rather than answer. Pick a model whose endpoints list `tools`."
    );
  } else if (options.toolRequirement && summary.toolEndpoints === 1 && summary.endpoints > 1) {
    notes.push(
      `Only one of ${summary.endpoints} endpoints declares tool support — if that provider is ` +
        "down or rate-limited, tool turns have nowhere to go."
    );
  }

  // ── 2. Whether the prompt cache can work at all ──
  if (summary.endpoints > 0 && summary.implicitCachingEndpoints === 0) {
    notes.push(
      summary.cachePricedEndpoints > 0
        ? `${summary.cachePricedEndpoints} of ${summary.endpoints} endpoints publish a cache-read rate, ` +
            "but none reports implicit caching — a cache hit depends on the provider, not only on the prefix."
        : "No endpoint reports implicit caching or a cache-read rate, so prompt caching cannot save anything here."
    );
  }

  // ── 3. Routing reality ──
  if (summary.providers === 1 && summary.endpoints === 1) {
    notes.push("One provider serves this model, so there is nothing to fail over to.");
  } else if (summary.priceSpread !== undefined) {
    notes.push(
      `Served by ${summary.providers} provider${summary.providers === 1 ? "" : "s"} — the same model, ` +
        `priced up to ${summary.priceSpread.toFixed(1)}× differently between them.`
    );
  }

  return notes;
}
