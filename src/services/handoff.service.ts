// ============================================================
// Handoff Service — dashboard demo → real tool
// ============================================================
// A dashboard demo can hand its current state to the matching tool so
// "open this in the real thing" lands on real content instead of an
// empty editor. The payload is staged in sessionStorage and announced
// with an event; hooks/useHandoffBridge applies it to the stores and
// performs the navigation, so demos never touch routing or stores.

export type HandoffTarget =
  | "compiler"
  | "api-tester"
  | "chat"
  | "drawflows"
  | "formatters"
  | "diff"
  | "comparators"
  | "library";

export type HandoffLanguage = "javascript" | "typescript" | "python" | "html";
export type HandoffMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface HandoffPayload {
  target: HandoffTarget;
  /** Human label used for the toast/CTA copy, e.g. "Fibonacci script". */
  label?: string;
  compiler?: { code: string; language?: HandoffLanguage; fileName?: string };
  request?: { url: string; method?: HandoffMethod; body?: string };
  chat?: { prompt: string };
  workflow?: { name?: string; elements: unknown[] };
  formatter?: { type: "json" | "xml"; content: string; name?: string };
  diff?: { original: string; modified: string; name?: string; language?: string };
  comparator?: { a: string; b: string; name?: string; mode?: "list" | "json" | "env" };
  library?: { tab?: "servicenow" | "drawflow"; query?: string; itemId?: string };
}

export const HANDOFF_ROUTES: Record<HandoffTarget, string> = {
  compiler: "/compiler",
  "api-tester": "/api-tester",
  chat: "/chat",
  drawflows: "/drawflows",
  formatters: "/formatters",
  diff: "/diff",
  comparators: "/comparators",
  library: "/library",
};

export const HANDOFF_EVENT = "intab:handoff";
/**
 * Navigation-ONLY signal.
 *
 * `requestHandoff` both applies a payload and asks the bridge to navigate,
 * which assumes the caller could not apply it. The chat agent can: it applies
 * the payload directly (services/handoff-bridge) so it can report whether the
 * tool actually loaded anything, and then fires this to move the user to the
 * tool it just filled. Re-dispatching the full handoff would apply the payload
 * a second time — a duplicate tab, a second diagram.
 */
export const HANDOFF_NAVIGATE_EVENT = "intab:handoff-navigate";
const HANDOFF_STORAGE_KEY = "intab_dashboard_handoff";

const CHAT_DRAFT_EVENT = "intab:chat-draft";
const CHAT_DRAFT_STORAGE_KEY = "intab_chat_draft";

/** Stages a payload and asks the bridge to navigate + apply it. */
export function requestHandoff(payload: HandoffPayload): void {
  try {
    sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — the event below still delivers the payload */
  }
  window.dispatchEvent(new CustomEvent<HandoffPayload>(HANDOFF_EVENT, { detail: payload }));
}

/** Reads and clears a staged payload (used on first mount / after a reload). */
export function readStoredHandoff(): HandoffPayload | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
    const parsed = JSON.parse(raw) as HandoffPayload;
    return parsed && typeof parsed.target === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearStoredHandoff(): void {
  try {
    sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Asks the bridge to navigate to a target without re-applying anything. */
export function requestHandoffRoute(target: HandoffTarget): void {
  try {
    window.dispatchEvent(new CustomEvent<HandoffTarget>(HANDOFF_NAVIGATE_EVENT, { detail: target }));
  } catch {
    /* no window (tests) — navigation is a nicety, not the result */
  }
}

/**
 * AI Chat owns its draft in component state, so handoffs stage the prompt
 * and announce it instead of writing into the chat store.
 */
export function stageChatDraft(prompt: string): void {
  try {
    sessionStorage.setItem(CHAT_DRAFT_STORAGE_KEY, prompt);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<string>(CHAT_DRAFT_EVENT, { detail: prompt }));
}

export function consumeChatDraft(): string | null {
  try {
    const prompt = sessionStorage.getItem(CHAT_DRAFT_STORAGE_KEY);
    if (!prompt) return null;
    sessionStorage.removeItem(CHAT_DRAFT_STORAGE_KEY);
    return prompt;
  } catch {
    return null;
  }
}

export const CHAT_DRAFT_CHANGED_EVENT = CHAT_DRAFT_EVENT;
