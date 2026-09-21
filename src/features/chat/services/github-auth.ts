// ============================================================
// GitHub Auth Service — OAuth Popup Flow & PAT Validation
// ============================================================
// OAuth: opens a popup to github.com/login/oauth/authorize with the
// redirect pointing at /api/github (edge function). The function
// exchanges the code server-side and postMessages the token back;
// we listen for it and validate by fetching the authenticated user.
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
const POPUP_TIMEOUT_MS = 120_000;

interface OAuthSuccess {
  ok: true;
  accessToken: string;
}
interface OAuthFailure {
  ok: false;
  error: string;
}
type OAuthPayload = OAuthSuccess | OAuthFailure;

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
      window.clearInterval(pollId);
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

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; payload?: OAuthPayload } | null;
      if (!data || data.source !== MESSAGE_SOURCE || !data.payload) return;
      finish(data.payload);
    };
    window.addEventListener("message", onMessage);

    // Poll for manual close (user closed the popup without finishing)
    const pollId = window.setInterval(() => {
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
    sessionStorage.setItem("intab:github-oauth-state", state);
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
      sessionStorage.removeItem("intab:github-oauth-state");
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
