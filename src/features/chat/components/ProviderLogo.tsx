import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { PROVIDER_LOGOS, type ProviderLogo } from "../lib/provider-logos";

/** Simple Icons paths are authored on a 24x24 canvas */
const VIEWBOX = "0 0 24 24";

/** Root OpenRouter slug for a model id: "deepseek/deepseek-chat" → "deepseek" */
function providerSlug(modelId: string): string {
  return modelId.split("/")[0]?.trim().toLowerCase() ?? "";
}

/** Brand match against the OpenRouter org slug (first path segment) */
function resolveProviderLogo(modelId: string): ProviderLogo | undefined {
  const slug = providerSlug(modelId);

  // Special cases where OpenRouter's slug and the brand diverge —
  // checked before the exact slug match. Anthropic models use the
  // Claude burst (the product mark users know); the plain Anthropic
  // "A" stays available for non-Claude anthropic/... ids.
  if (slug === "anthropic") {
    if (modelId.toLowerCase().includes("claude")) return PROVIDER_LOGOS["claude"];
    return PROVIDER_LOGOS["anthropic"];
  }

  // Exact slug match (openai, deepseek, mistralai, …)
  const exact = PROVIDER_LOGOS[slug];
  if (exact) return exact;

  if (slug === "x-ai") return PROVIDER_LOGOS["x"]; // Grok → X mark
  if (slug === "meta-llama") return PROVIDER_LOGOS["meta"];
  if (slug === "google") return PROVIDER_LOGOS["googlegemini"];

  // Substring fallbacks for longer slugs (e.g. "microsoft/phi-4")
  for (const [key, logo] of Object.entries(PROVIDER_LOGOS)) {
    if (slug.includes(key)) return logo;
  }
  return undefined;
}

/**
 * Whether this model's org has a brand mark. Callers need this apart
 * from <ProviderLogo/>: that component renders `null` for an unknown
 * org, so a chip pairing it with a generic icon has to choose between
 * the two instead of stacking both (which is what the model chip did)
 * or leaving a hole.
 *
 * Deliberately not exported — a component module is only allowed to
 * export components (react-refresh/only-export-components).
 */
function hasProviderLogo(modelId: string): boolean {
  return resolveProviderLogo(modelId) !== undefined;
}

interface ProviderLogoProps {
  modelId: string;
  className?: string;
  /** Render in currentColor instead of the official brand color */
  monochrome?: boolean;
}

/**
 * Official provider brand mark (Simple Icons, CC0). Renders nothing
 * when the org has no mark — prefer <ProviderMark/> in UI chrome, where
 * a missing glyph would leave an empty slot.
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

/**
 * Brand mark with a generic fallback.
 *
 * An unrecognized org used to render nothing at all, which left the
 * leading slot of every chip empty and shifted the label beside it.
 * The generic glyph keeps the slot occupied and says "provider
 * unknown" instead of "nothing here".
 */
export function ProviderMark({ modelId, className, monochrome = false }: ProviderLogoProps) {
  if (!hasProviderLogo(modelId)) {
    return <Bot className={cn("chat-provider-mark", className)} aria-hidden="true" />;
  }
  return (
    <ProviderLogo modelId={modelId} className={className} monochrome={monochrome} />
  );
}
