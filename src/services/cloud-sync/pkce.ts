// ============================================================
// Cloud Sync — PKCE OAuth Utility
// ============================================================
// Shared PKCE helpers for OneDrive (Microsoft) and Google Drive.
// Runs entirely in the browser: no client secret, no backend.
// The popup lands on a tiny static callback page (public/oauth/callback.html)
// that completes the code exchange via fetch and postMessages the result.
// The PKCE verifier is persisted in sessionStorage keyed by the OAuth
// state so a popup retry / refresh keeps working.

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

const VERIFIER_KEY_PREFIX = "intab_pkce_verifier_";
const FLOW_KEY_PREFIX = "intab_oauth_flow_";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generates a PKCE code verifier (RFC 7636 §4.1) */
function generateVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

/** S256 code challenge (RFC 7636 §4.2) */
async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function randomState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** Persists flow context so the callback page can complete the exchange.
 * Uses localStorage (shared across same-origin windows) because the OAuth
 * popup runs in a separate tab and cannot read the opener's sessionStorage. */
export function beginPkceFlow(config: {
  clientId: string;
  provider: "onedrive" | "googledrive";
  scopes: string;
}): PkcePair {
  const verifier = generateVerifier();
  const state = randomState();

  const flowContext = JSON.stringify({
    verifier,
    clientId: config.clientId,
    provider: config.provider,
    scopes: config.scopes,
    startedAt: Date.now(),
  });

  // Handoff for the callback page (cross-window) + opener-side copy
  localStorage.setItem(OAUTH_HANDOFF_PREFIX + state, flowContext);
  sessionStorage.setItem(FLOW_KEY_PREFIX + state, flowContext);

  return { verifier, challenge: "", state };
}

const OAUTH_HANDOFF_PREFIX = "intab_oauth_handoff_";
const OAUTH_RESULT_PREFIX = "intab_oauth_result_";

/** Reads (and removes) the OAuth result the callback page wrote to localStorage. */
export function consumeOAuthResult(state: string):
  | { ok: true; tokens: { accessToken: string; refreshToken: string | null; expiresIn: number; scope: string } }
  | { ok: false; error: string }
  | null {
  const raw = localStorage.getItem(OAUTH_RESULT_PREFIX + state);
  if (!raw) return null;
  localStorage.removeItem(OAUTH_RESULT_PREFIX + state);
  localStorage.removeItem(OAUTH_HANDOFF_PREFIX + state);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Removes stale flow context (cancelled sign-in). */
export function cleanupOAuthFlow(state: string): void {
  localStorage.removeItem(OAUTH_HANDOFF_PREFIX + state);
  localStorage.removeItem(OAUTH_RESULT_PREFIX + state);
  sessionStorage.removeItem(FLOW_KEY_PREFIX + state);
}

export type OAuthPopupResult =
  | { ok: true; tokens: { accessToken: string; refreshToken: string | null; expiresIn: number; scope: string } }
  | { ok: false; error: string };

/** Waits (polling localStorage) for the callback page to deliver the result. */
export function waitForOAuthResult(state: string, timeoutMs = 8000): Promise<OAuthPopupResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = window.setInterval(() => {
      const result = consumeOAuthResult(state);
      if (result) {
        window.clearInterval(poll);
        resolve(result);
      } else if (Date.now() - startedAt > timeoutMs) {
        window.clearInterval(poll);
        cleanupOAuthFlow(state);
        reject(new Error("Sign-in was cancelled or did not complete."));
      }
    }, 300);
  });
}

/** Reads and removes stored flow context for a state. */
export function consumePkceFlow(state: string): {
  verifier: string;
  clientId: string;
  provider: "onedrive" | "googledrive";
  scopes: string;
} | null {
  const raw = sessionStorage.getItem(FLOW_KEY_PREFIX + state);
  if (!raw) return null;
  sessionStorage.removeItem(FLOW_KEY_PREFIX + state);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Builds the authorize URL for the given provider. `redirectUri` must be
 * registered in the provider's app console and host callback.html.
 */
export async function buildAuthorizeUrl(params: {
  provider: "onedrive" | "googledrive";
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  verifier: string;
}): Promise<string> {
  const challenge = await challengeFromVerifier(params.verifier);

  if (params.provider === "googledrive") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", params.scopes);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  // OneDrive / Microsoft identity platform (consumers + orgs)
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenEndpointConfig {
  provider: "onedrive" | "googledrive";
  clientId: string;
  redirectUri: string;
}

/** Token endpoint + shared fetch semantics per provider. */
export async function exchangeCodeForTokens(
  config: TokenEndpointConfig,
  code: string,
  verifier: string
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  const url =
    config.provider === "googledrive"
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in ?? 3600,
    scope: json.scope ?? "",
  };
}

/** Refresh grant against the provider token endpoint. */
export async function refreshTokens(
  config: Omit<TokenEndpointConfig, "redirectUri">,
  refreshToken: string
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const url =
    config.provider === "googledrive"
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: json.access_token,
    // Microsoft may omit refresh_token on refresh; keep the previous one then.
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in ?? 3600,
    scope: json.scope ?? "",
  };
}

/** Opens the OAuth popup and resolves when the flow completes or fails. */
export function openOAuthPopup(authorizeUrl: string, providerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const width = 520;
    const height = 640;
    const y = window.top!.outerHeight / 2 + window.screenY - height / 2;
    const x = window.top!.outerWidth / 2 + window.screenX - width / 2;
    const popup = window.open(
      authorizeUrl,
      `intab-oauth-${providerName}`,
      `width=${width},height=${height},top=${y},left=${x}`
    );

    if (!popup) {
      reject(new Error("Popup blocked. Please allow popups for this site and try again."));
      return;
    }

    // Focused polling: resolve when popup closes (success is signaled via
    // storage event from the callback page, failure via same mechanism).
    const timer = setInterval(() => {
      if (popup.closed) {
        clearInterval(timer);
        resolve();
      }
    }, 500);

    // Hard timeout to avoid a dangling promise
    setTimeout(() => {
      if (!popup.closed) {
        clearInterval(timer);
        try {
          popup.close();
        } catch {
          /* noop */
        }
        reject(new Error("Sign-in timed out. Please try again."));
      }
    }, 5 * 60 * 1000);
  });
}
