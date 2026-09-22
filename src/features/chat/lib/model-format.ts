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
