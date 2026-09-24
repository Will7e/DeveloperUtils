// ============================================================
// useModelEndpoints — who serves the selected model
// ============================================================
// Fetch-on-selection rather than fetch-on-hover, for one reason: the context
// card is a hover surface, and a number that appears a second after you open it
// is worse than a number that is already there. The request is one per model per
// ten minutes (`model-catalog.ts` owns that cache), so paying it when the model
// changes is cheaper than paying it every time a card renders.
//
// The cache IS the state, read through `useSyncExternalStore`, so there is no
// local copy to drift: the effect's only job is to START a fetch, and the answer
// arrives by waking this subscription. That also makes a stale answer
// unrepresentable — a reply for a model that is no longer selected lands in the
// cache under its own id, and this hook is reading a different key by then.
//
// Returns null while unknown, and keeps returning the last answer if a refresh
// fails — see `ensureModelEndpoints` for why that is best-effort.

import React from "react";
import {
  ensureModelEndpoints,
  getCachedEndpoints,
  subscribeModelEndpoints,
} from "../lib/model-catalog";
import type { EndpointSummary } from "../lib/model-endpoints";
import { useChatStore } from "@/stores/chat.store";

export function useModelEndpoints(modelId?: string): EndpointSummary | null {
  const apiKey = useChatStore((s) => s.settings.apiKey);

  const subscribe = React.useCallback(
    (onChange: () => void) => (modelId ? subscribeModelEndpoints(modelId, onChange) : () => {}),
    [modelId]
  );
  const getSnapshot = React.useCallback(() => getCachedEndpoints(modelId), [modelId]);
  const summary = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useEffect(() => {
    const key = apiKey?.trim();
    if (!modelId || !key) return;
    // Already answered (or being answered) — `ensureModelEndpoints` coalesces and
    // serves from cache, so this is safe to call on every selection change.
    void ensureModelEndpoints(key, modelId);
  }, [modelId, apiKey]);

  return summary;
}
