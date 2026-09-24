// ============================================================
// GitHub Auth Service — OAuth Popup Flow & PAT Validation
// ============================================================
// OAuth: opens a popup to github.com/login/oauth/authorize with the
// redirect pointing at /api/github (edge function). The function
// exchanges the code server-side and hands the token back; we listen
// for it and validate by fetching the authenticated user.
//
// The hand-back arrives over a BROADCASTCHANNEL, and that is a consequence of
// the browser workspace, not a preference: the app is served with
// `Cross-Origin-Opener-Policy: same-origin` (measured — see
// container/isolation.ts) and that puts the popup in its own browsing context
// group the moment it visits github.com. `window.opener` is then null inside it
// and `popup.closed` reads true forever in here, so neither `opener.postMessage`
// nor a "was it closed?" poll can be trusted. A BroadcastChannel is scoped to the
// ORIGIN, which survives both. The postMessage listener stays for the browsers and
// flows where the opener does survive.
//
// PAT: validated the same way (GET /user) before being accepted.
//
// Tokens live in ChatSettings (encrypted at rest, same as the
// OpenRouter key) — this module is stateless and store-free.

import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_OAUTH_SCOPES,
  GITHUB_POPUP_HEIGHT,
  GITHUB_POPUP_WIDTH,
} from "../constants";
import { getAuthenticatedUser } from "../lib/github-client";
import type { GitHubConnectionState, GitHubSettings } from "../types";

const VITE_GITHUB_CLIENT_ID =
  (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) || "";

const MESSAGE_SOURCE = "intab-github-oauth";
/** Must match the name in public/oauth/github-popup.js */
const BROADCAST_CHANNEL = "intab-github-oauth";
const POPUP_TIMEOUT_MS = 120_000;
/** Where the OAuth `state` we generated is stashed for the CSRF check */
const OAUTH_STATE_KEY = "intab:github-oauth-state";

interface OAuthSuccess {
  ok: true;
  accessToken: string;
  /** Echoed by /api/github so we can verify the response is ours */
  state?: string;
}
interface OAuthFailure {
  ok: false;
  error: string;
  state?: string;
}
type OAuthPayload = OAuthSuccess | OAuthFailure;

/**
 * Reads the stashed state. Returns null when storage is unavailable, in which
 * case the check is skipped rather than turning every sign-in into a failure.
 */
function readStashedState(): string | null {
  try {
    return sessionStorage.getItem(OAUTH_STATE_KEY);
  } catch {
    return null;
  }
}

/** Opens the OAuth popup and resolves with the exchanged token */
function openOAuthPopup(authorizeUrl: string): Promise<OAuthPayload> {
  return new Promise((resolve) => {
    const width = GITHUB_POPUP_WIDTH;
    const height = GITHUB_POPUP_HEIGHT;
    const y = window.top?.outerHeight
      ? window.top.outerHeight / 2 + (window.top.screenY || 0) - height / 2
      : 200;
    const x = window.top?.outerWidth
      ? window.top.outerWidth / 2 + (window.top.screenX || 0) - width / 2
      : 200;

    const popup = window.open(
      authorizeUrl,
      "intab-github-oauth",
      `popup=yes,width=${width},height=${height},left=${Math.max(0, x)},top=${Math.max(0, y)}`
    );

    if (!popup) {
      resolve({ ok: false, error: "Popup blocked — allow popups for this site to use GitHub sign-in." });
      return;
    }

    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      channel?.removeEventListener("message", onChannel);
      channel?.close();
      if (pollId) window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
    };
    const finish = (payload: OAuthPayload) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        popup.close();
      } catch {
        /* popup already gone */
      }
      resolve(payload);
    };

    /**
     * Accepts a payload only if it survived the CSRF state check.
     *
     * Shared by both channels. The state check is the guard that matters on the
     * BroadcastChannel, where any same-origin document can publish: a payload
     * whose `state` is not the one this sign-in generated is dropped rather than
     * stored as the GitHub token.
     */
    const accept = (data: { source?: string; payload?: OAuthPayload } | null | undefined) => {
      if (!data || data.source !== MESSAGE_SOURCE || !data.payload) return;
      const expected = readStashedState();
      if (expected && data.payload.state !== expected) {
        finish({
          ok: false,
          error: "GitHub sign-in response failed its state check — try again.",
        });
        return;
      }
      finish(data.payload);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      // The credential must come from the popup this call opened — not from
      // any other same-origin frame that can reach this window.
      if (event.source !== popup) return;
      accept(event.data as { source?: string; payload?: OAuthPayload } | null);
    };
    window.addEventListener("message", onMessage);

    // The channel the popup actually delivers on under `COOP: same-origin`.
    // Origin-scoped, so it works with no opener relationship at all.
    const channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(BROADCAST_CHANNEL) : null;
    const onChannel = (event: MessageEvent) =>
      accept(event.data as { source?: string; payload?: OAuthPayload } | null);
    channel?.addEventListener("message", onChannel);

    // Poll for manual close (user closed the popup without finishing).
    //
    // Skipped on a cross-origin isolated page, where the check is a false alarm:
    // COOP puts the popup in its own browsing context group, so the handle reports
    // `closed === true` from the first tick while the user is still signing in —
    // which cancelled every sign-in within 400ms. The timeout below covers the
    // case this poll exists for.
    const pollId = window.crossOriginIsolated
      ? 0
      : window.setInterval(() => {
          if (popup.closed && !settled) {
            finish({ ok: false, error: "GitHub sign-in was cancelled." });
          }
        }, 400);

    const timeoutId = window.setTimeout(() => {
      finish({ ok: false, error: "GitHub sign-in timed out — try again." });
    }, POPUP_TIMEOUT_MS);
  });
}

/** Builds the GitHub authorize URL (state = CSRF guard, echoed by the callback) */
function buildAuthorizeUrl(): string {
  const state = crypto.randomUUID();
  // Stash the state so the edge function can echo it back verbatim
  try {
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
  } catch {
    /* storage unavailable — flow still works, just without state check */
  }
  const params = new URLSearchParams({
    client_id: VITE_GITHUB_CLIENT_ID,
    redirect_uri: `${window.location.origin}/api/github`,
    scope: GITHUB_OAUTH_SCOPES,
    state,
    allow_signup: "true",
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Runs the full OAuth connect flow. Returns the settings patch to
 * apply (token + identity) on success, or an error state — never throws.
 */
export async function connectViaOAuth(): Promise<
  { ok: true; settings: GitHubSettings } | { ok: false; state: GitHubConnectionState }
> {
  if (!VITE_GITHUB_CLIENT_ID) {
    return {
      ok: false,
      state: {
        status: "error",
        message:
          "GitHub OAuth is not configured (missing VITE_GITHUB_CLIENT_ID). Use a Personal Access Token instead.",
      },
    };
  }

  try {
    const payload = await openOAuthPopup(buildAuthorizeUrl());
    if (!payload.ok) {
      return { ok: false, state: { status: "error", message: payload.error } };
    }
    try {
      sessionStorage.removeItem(OAUTH_STATE_KEY);
    } catch {
      /* ignore */
    }

    const user = await getAuthenticatedUser(payload.accessToken);
    return {
      ok: true,
      settings: {
        token: payload.accessToken,
        mode: "oauth",
        login: user.login,
        avatarUrl: user.avatarUrl,
        connectedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      state: {
        status: "error",
        message: err instanceof Error ? err.message : "GitHub sign-in failed.",
      },
    };
  }
}

/**
 * Validates a user-pasted PAT and returns the settings patch to
 * apply on success, or an error state — never throws.
 */
export async function connectWithToken(
  token: string
): Promise<{ ok: true; settings: GitHubSettings } | { ok: false; state: GitHubConnectionState }> {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      ok: false,
      state: { status: "error", message: "Enter a token first." },
    };
  }
  try {
    const user = await getAuthenticatedUser(trimmed);
    return {
      ok: true,
      settings: {
        token: trimmed,
        mode: "pat",
        login: user.login,
        avatarUrl: user.avatarUrl,
        connectedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      state: {
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "Could not validate the token with GitHub.",
      },
    };
  }
}
