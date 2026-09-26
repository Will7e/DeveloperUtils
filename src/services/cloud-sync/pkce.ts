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

  // Hygiene: expired handoffs (≥15 min old) are useless — the flow would
  // fail client-side anyway. Sweep them so cancelled sign-ins don't leave
  // PKCE verifiers lying around in localStorage indefinitely.
  try {
    const doomed: string[] = [];
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(OAUTH_HANDOFF_PREFIX)) continue;
      try {
        const ctx = JSON.parse(localStorage.getItem(k) || "{}") as { startedAt?: number };
        if (!ctx.startedAt || now - ctx.startedAt > 15 * 60 * 1000) doomed.push(k);
      } catch {
        doomed.push(k);
      }
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage unavailable */
  }

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
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      error?: string;
      tokens?: { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown; scope?: unknown };
    };
    if (parsed && parsed.ok) {
      // Shape validation: a malformed/corrupt entry must never be treated
      // as a usable credential.
      const t = parsed.tokens;
      if (!t || typeof t.accessToken !== "string" || t.accessToken.length === 0) {
        return { ok: false, error: "Sign-in completed but the token payload was invalid." };
      }
      return {
        ok: true,
        tokens: {
          accessToken: t.accessToken,
          refreshToken: typeof t.refreshToken === "string" ? t.refreshToken : null,
          expiresIn: typeof t.expiresIn === "number" && Number.isFinite(t.expiresIn) ? t.expiresIn : 3600,
          scope: typeof t.scope === "string" ? t.scope : "",
        },
      };
    }
    return { ok: false, error: parsed?.error || "Sign-in failed." };
  } catch {
    return { ok: false, error: "Sign-in result was unreadable." };
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

/** BroadcastChannel name the callback page relays on — must match public/oauth/callback.js */
const OAUTH_BC_NAME = "intab-cloud-sync-oauth";

/**
 * Subscribes to the callback page's BroadcastChannel relay. COOP
 * `same-origin` nulls `window.opener` once the popup has crossed to
 * accounts.google.com / login.microsoftonline.com, so postMessage from the
 * callback cannot reach us — the channel is per-origin and survives that.
 */
function subscribeToCallbackRelay(onMessage: (e: MessageEvent) => void): BroadcastChannel | null {
  try {
    const channel = new BroadcastChannel(OAUTH_BC_NAME);
    channel.onmessage = onMessage;
    return channel;
  } catch {
    return null; // No BroadcastChannel support — localStorage polling remains
  }
}

/** Waits (polling localStorage, storage events, and relays) for the callback page to deliver the result. */
export function waitForOAuthResult(state: string, timeoutMs = 300000): Promise<OAuthPopupResult> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const startedAt = Date.now();
    let relay: BroadcastChannel | null = null;

    const finish = (result: OAuthPopupResult) => {
      if (resolved) return;
      resolved = true;
      window.clearInterval(poll);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("message", onMessage);
      relay?.close();
      resolve(result);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === OAUTH_RESULT_PREFIX + state && e.newValue) {
        const result = consumeOAuthResult(state);
        if (result) finish(result);
      }
    };
    window.addEventListener("storage", onStorage);

    const onMessage = (e: MessageEvent) => {
      // BroadcastChannel messages carry the page's own origin; postMessage
      // from the callback is only trusted when it is genuinely same-origin.
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "intab-oauth-complete" && e.data?.state === state) {
        if (e.data.tokens) {
          cleanupOAuthFlow(state);
          finish({ ok: true, tokens: e.data.tokens });
        } else if (e.data.error) {
          cleanupOAuthFlow(state);
          finish({ ok: false, error: e.data.error });
        } else {
          const result = consumeOAuthResult(state);
          if (result) finish(result);
        }
      }
    };
    window.addEventListener("message", onMessage);
    relay = subscribeToCallbackRelay(onMessage);

    const poll = window.setInterval(() => {
      const result = consumeOAuthResult(state);
      if (result) {
        finish(result);
      } else if (Date.now() - startedAt > timeoutMs) {
        if (resolved) return;
        resolved = true;
        window.clearInterval(poll);
        window.removeEventListener("storage", onStorage);
        window.removeEventListener("message", onMessage);
        relay?.close();
        cleanupOAuthFlow(state);
        reject(new Error("Sign-in timed out or was cancelled."));
      }
    }, 300);
  });
}

/**
 * Opens the OAuth popup and awaits the result via localStorage / postMessage.
 * Avoids race conditions and premature timeouts from COOP navigation severance.
 */
export function openOAuthPopupAndAwaitResult(
  authorizeUrl: string,
  providerName: string,
  state: string,
  timeoutMs = 300000
): Promise<OAuthPopupResult> {
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
      cleanupOAuthFlow(state);
      reject(new Error("Popup blocked. Please allow popups for this site and try again."));
      return;
    }

    let settled = false;
    let pollTimer: number | null = null;
    let timeoutTimer: number | null = null;
    let relay: BroadcastChannel | null = null;
    const startedAt = Date.now();

    const cleanup = () => {
      settled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("message", onMessage);
      relay?.close();
    };

    const finish = (result: OAuthPopupResult) => {
      if (settled) return;
      cleanup();
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* cross-origin */
      }
      resolve(result);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === OAUTH_RESULT_PREFIX + state && e.newValue) {
        const result = consumeOAuthResult(state);
        if (result) finish(result);
      }
    };
    window.addEventListener("storage", onStorage);

    const onMessage = (e: MessageEvent) => {
      // BroadcastChannel messages carry the page's own origin; postMessage
      // from the callback is only trusted when it is genuinely same-origin.
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "intab-oauth-complete" && e.data?.state === state) {
        if (e.data.tokens) {
          cleanupOAuthFlow(state);
          finish({ ok: true, tokens: e.data.tokens });
        } else if (e.data.error) {
          cleanupOAuthFlow(state);
          finish({ ok: false, error: e.data.error });
        } else {
          const result = consumeOAuthResult(state);
          if (result) finish(result);
        }
      }
    };
    window.addEventListener("message", onMessage);
    relay = subscribeToCallbackRelay(onMessage);

    pollTimer = window.setInterval(() => {
      if (settled) return;
      const result = consumeOAuthResult(state);
      if (result) {
        finish(result);
        return;
      }

      // Check popup closed — but NOT on a cross-origin isolated page. COOP
      // `same-origin` puts the popup in its own browsing context group, and
      // the handle then reports `closed === true` from the first tick while
      // the user is still on the provider's consent screen — this check is
      // what cancelled sign-ins five seconds in. The GitHub popup flow ships
      // the same guard. The timeout below remains the backstop.
      if (!window.crossOriginIsolated && Date.now() - startedAt > 5000) {
        try {
          if (popup.closed) {
            const lastCheck = consumeOAuthResult(state);
            if (lastCheck) {
              finish(lastCheck);
            } else {
              cleanup();
              cleanupOAuthFlow(state);
              reject(
                new Error(
                  "The sign-in window closed before completing. If it showed a provider error page, the likely cause is the redirect URI registered in the provider console — it must match " +
                    window.location.origin +
                    "/oauth/callback.html exactly, path included."
                )
              );
            }
          }
        } catch {
          /* cross-origin permission error on popup.closed */
        }
      }
    }, 300);

    timeoutTimer = window.setTimeout(() => {
      if (settled) return;
      cleanup();
      cleanupOAuthFlow(state);
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* noop */
      }
      reject(new Error("Sign-in timed out. Please try again."));
    }, timeoutMs);
  });
}

/** The redirect URI this origin would register with the provider console. */
function defaultRedirectUri(): string {
  try {
    return `${window.location.origin}/oauth/callback.html`;
  } catch {
    return "/oauth/callback.html";
  }
}

/**
 * Translates a Microsoft authorize-stage error into actionable guidance, or
 * null when the error is not one of the known configuration shapes. Azure's
 * raw messages ("AADSTS9002326: Cross-origin token redemption…") name the
 * protocol, not the fix — the redirect platform type is the fix, and it is
 * only editable in the Azure portal.
 */
export function describeMicrosoftAuthorizeError(
  raw: string,
  redirectUri: string = defaultRedirectUri()
): string | null {
  const message = raw ?? "";
  if (/AADSTS9002326|cross-origin token redemption/i.test(message)) {
    return `Azure rejected the sign-in: ${redirectUri} is registered as platform "Web". In the Azure app registration, add it under Authentication as platform "Single-page application (SPA)" and retry.`;
  }
  if (/AADSTS50199|response_mode/i.test(message)) {
    return 'Azure rejected the response mode. This app requests the default (fragment) response; if this persists, replace the platform "Web" redirect URI in Azure with a "Single-page application (SPA)" one.';
  }
  if (/AADSTS50011/i.test(message)) {
    return `Azure did not recognize the redirect URI ${redirectUri}. Add it under Azure → Authentication → Redirect URIs as platform "Single-page application (SPA)", including the www host you are signed in on.`;
  }
  return null;
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
  // No `response_mode` parameter: redirect URIs registered as platform "SPA"
  // (the only type that accepts PKCE authorization-code requests from the
  // browser) are required by Microsoft to return the code in the URL fragment
  // and reject an explicit `response_mode=query` — the mismatch read to users
  // as "the redirect URL was not correct" even with Azure configured exactly
  // right. The callback page parses the fragment, so the default is fine.
  const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes);
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
