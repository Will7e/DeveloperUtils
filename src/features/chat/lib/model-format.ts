// ============================================================
// Model Formatting — Shared display strings for model metadata
// ============================================================
// A leaf module with no imports: these are pure string builders used by
// the picker dropdown, the command menu and the header chip. They live
// here rather than beside the components because a component module that
// also exports functions breaks fast refresh (react-refresh/
// only-export-components) for the whole file.

/** Price per million prompt tokens, as the dropdown shows it */
export function formatPrice(price?: number): string {
  if (price === undefined) return "";
  if (price === 0) return "Free";
  return `$${price.toFixed(2)}`;
}

/** Context window, rounded to the size a human compares at a glance */
export function formatContext(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  return `${Math.round(n / 1000)}k ctx`;
}

/**
 * Label for the model chip when the catalog has no entry for this id yet
 * (no key, or the first load before the list arrives).
 *
 * The raw wire id is both too long to fit the chip and redundant — the
 * mark beside it already says which org serves it — so the org prefix is
 * dropped, exactly as catalog names omit it. The full id stays in the
 * chip's tooltip, so truncation never hides which model is selected.
 */
export function formatModelLabel(modelId: string): string {
  const slash = modelId.indexOf("/");
  const tail = slash === -1 ? "" : modelId.slice(slash + 1);
  // An org with no model behind it would otherwise render an empty chip.
  return tail || modelId;
}

/**
 * OpenRouter's routing slugs: ids that CHOOSE a model rather than being one.
 *
 * Worth naming in the picker, because everything else the row shows is a
 * property of a model and none of it is a property of a router. A router has no
 * price (the model it picks does), its context window is whichever model it
 * lands on, and its "capability" is a policy rather than a measurement — so a
 * row that reads like the others teaches the user something false about what
 * they just selected.
 */
const ROUTER_NOTES: Record<string, string> = {
  "openrouter/auto": "Not a model — OpenRouter picks the model it rates best for each request",
  "openrouter/auto-beta": "Not a model — OpenRouter's beta router, which picks a model per request",
  "openrouter/pareto-code":
    "Not a model — routes each request to the cheapest model above a coding-quality bar",
  "openrouter/free": "Not a model — routes to a free model, inside the free-tier rate limits",
  "openrouter/bodybuilder": "Not a model — builds request bodies rather than answering them",
};

/**
 * Why this id is a router rather than a model, or "" when it is a model.
 *
 * Matched on the exact slug rather than the `openrouter/` prefix: that org
 * publishes real models under its own namespace too, and labelling one of those
 * a router would be the same mistake in the other direction.
 */
export function routerNote(modelId: string): string {
  return ROUTER_NOTES[modelId.trim().toLowerCase()] ?? "";
}

/**
 * The prompt-price cliff, as a badge: `2× over 272k`, or "" for a flat price.
 *
 * Tiered pricing is a step function, not a gradient — past the threshold the
 * tier rates REPLACE the base rate, so a model can double its price on a long
 * conversation. A picker that showed only the entry price would make the
 * cheapest option look cheaper than it is on exactly the turns that cost the
 * most, so the cliff is stated where the choice is made.
 *
 * Takes a structural shape rather than `ModelInfo` so this module stays
 * import-free (see the header): a component module that imports the type graph
 * breaks fast refresh for every file that uses these formatters.
 */
export function formatPriceTier(info: {
  promptPrice?: number;
  priceOverrides?: Array<{ minPromptTokens: number; promptPrice?: number }>;
}): string {
  const tiers = info.priceOverrides;
  if (!tiers || tiers.length === 0) return "";
  const first = [...tiers].sort((a, b) => a.minPromptTokens - b.minPromptTokens)[0]!;
  const threshold = formatContext(first.minPromptTokens).replace(" ctx", "");
  const base = info.promptPrice;
  const next = first.promptPrice;
  // Only a multiple when both rates are known and the base is not zero — a free
  // model with a paid tier is a different sentence, and the badge says so.
  if (base !== undefined && base > 0 && next !== undefined) {
    const ratio = next / base;
    if (Math.abs(ratio - 1) < 0.05) return `same rate over ${threshold} tokens`;
    return `${ratio < 10 ? ratio.toFixed(ratio % 1 === 0 ? 0 : 1) : "10+"}× over ${threshold}`;
  }
  return `tiered over ${threshold}`;
}

/** The full sentence behind the tier badge, for its tooltip */
export function priceTierTitle(info: {
  promptPrice?: number;
  priceOverrides?: Array<{ minPromptTokens: number; promptPrice?: number }>;
}): string {
  const badge = formatPriceTier(info);
  if (!badge) return "";
  const tiers = [...(info.priceOverrides ?? [])].sort(
    (a, b) => a.minPromptTokens - b.minPromptTokens
  );
  const rates = tiers
    .map(
      (t) =>
        `above ${t.minPromptTokens.toLocaleString()} tokens: ${formatPrice(t.promptPrice)}/M in`
    )
    .join("; ");
  return (
    `This model's prompt price is not flat — past a threshold the tier rate replaces the base rate, ` +
    `which is why a long conversation costs a multiple of a short one. ${rates}. ` +
    `Cost estimates below the threshold use the base rate of ${formatPrice(info.promptPrice)}/M.`
  );
}
