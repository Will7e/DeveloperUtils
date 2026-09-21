import { PROVIDER_LOGOS, type ProviderLogo } from "../lib/provider-logos";

/** Simple Icons paths are authored on a 24x24 canvas */
const VIEWBOX = "0 0 24 24";

/** Root OpenRouter slug for a model id: "deepseek/deepseek-chat" → "deepseek" */
export function providerSlug(modelId: string): string {
  return modelId.split("/")[0]?.trim().toLowerCase() ?? "";
}

/** Brand match against the OpenRouter org slug (first path segment) */
export function resolveProviderLogo(modelId: string): ProviderLogo | undefined {
  const slug = providerSlug(modelId);

  // Exact slug match first (openai, anthropic, deepseek, mistralai, …)
  const exact = PROVIDER_LOGOS[slug];
  if (exact) return exact;

  // Special cases where OpenRouter's slug and the brand diverge
  if (slug === "x-ai") return PROVIDER_LOGOS["x"]; // Grok → X mark
  if (slug === "meta-llama") return PROVIDER_LOGOS["meta"];
  if (slug === "google") return PROVIDER_LOGOS["googlegemini"];

  // Substring fallbacks for longer slugs (e.g. "microsoft/phi-4")
  for (const [key, logo] of Object.entries(PROVIDER_LOGOS)) {
    if (slug.includes(key)) return logo;
  }
  return undefined;
}

interface ProviderLogoProps {
  modelId: string;
  className?: string;
  /** Render in currentColor instead of the official brand color */
  monochrome?: boolean;
}

/**
 * Official provider brand mark (Simple Icons, CC0). Falls back to
 * nothing rendered — callers should pair it with a generic glyph.
 */
export function ProviderLogo({ modelId, className, monochrome = false }: ProviderLogoProps) {
  const logo = resolveProviderLogo(modelId);
  if (!logo) return null;
  return (
    <svg
      viewBox={VIEWBOX}
      className={className}
      role="img"
      aria-label={logo.title}
      fill={monochrome ? "currentColor" : logo.hex}
    >
      <path d={logo.path} />
    </svg>
  );
}
