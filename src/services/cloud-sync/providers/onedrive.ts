// ============================================================
// Cloud Sync — Microsoft OneDrive Provider (app folder)
// ============================================================
// Uses Graph API's special appFolder (`/me/drive/special/approot`)
// which maps to Files.ReadWrite.AppFolder — a hidden per-app folder
// users cannot see or accidentally delete. Zero Microsoft verification
// is required for consumer accounts.

import type { CloudProvider, FileReadResult, OAuthTokens, WriteResult } from "../types";
import { OAuthError } from "../oauth-error";
import {
  buildAuthorizeUrl,
  beginPkceFlow,
  refreshTokens,
  openOAuthPopup,
  waitForOAuthResult,
} from "../pkce";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "Files.ReadWrite.AppFolder offline_access User.Read";
const CLIENT_ID = (import.meta.env.VITE_MSFT_CLIENT_ID as string | undefined) || "";

function redirectUri(): string {
  return `${window.location.origin}/oauth/callback.html`;
}

interface GraphIdentity {
  mail?: string | null;
  userPrincipalName?: string;
  id: string;
}

async function graphFetch(
  tokens: OAuthTokens,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) throw new OAuthError("access token expired", "token_expired");
  return res;
}

/** Fetches the user's identity for a stable account label. */
async function fetchIdentity(tokens: OAuthTokens): Promise<GraphIdentity | null> {
  try {
    const res = await graphFetch(tokens, "/me");
    if (!res.ok) return null;
    return (await res.json()) as GraphIdentity;
  } catch {
    return null;
  }
}

export const oneDriveProvider: CloudProvider = {
  id: "onedrive",
  displayName: "OneDrive",

  async signIn(): Promise<OAuthTokens> {
    if (!CLIENT_ID) throw new Error("OneDrive sign-in is not configured (missing VITE_MSFT_CLIENT_ID).");

    const flow = beginPkceFlow({ clientId: CLIENT_ID, provider: "onedrive", scopes: SCOPES });
    const authorizeUrl = await buildAuthorizeUrl({
      provider: "onedrive",
      clientId: CLIENT_ID,
      redirectUri: redirectUri(),
      scopes: SCOPES,
      state: flow.state,
      verifier: flow.verifier,
    });

    // Launch the popup; it stays open until the user finishes (or cancels).
    // The callback page writes the result to localStorage before closing.
    await openOAuthPopup(authorizeUrl, "onedrive");
    const result = await waitForOAuthResult(flow.state, 5000);
    if (!result.ok) throw new Error(result.error);

    const now = Date.now();
    const base: OAuthTokens = {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresAt: now + result.tokens.expiresIn * 1000,
      scope: result.tokens.scope,
      accountEmail: "",
      accountId: "",
      obtainedAt: now,
    };

    const identity = await fetchIdentity(base);
    base.accountEmail = identity?.mail || identity?.userPrincipalName || "OneDrive account";
    base.accountId = identity?.id || base.accountEmail;

    return base;
  },

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) throw new OAuthError("No refresh token available", "no_refresh_token");
    const refreshed = await refreshTokens({ provider: "onedrive", clientId: CLIENT_ID }, tokens.refreshToken);
    return {
      ...tokens,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
      scope: refreshed.scope || tokens.scope,
    };
  },

  async signOut(tokens: OAuthTokens | null): Promise<void> {
    // Best-effort revocation: MS Identity v2 revoke endpoint isn't public;
    // clearing local tokens is the practical approach.
    void tokens;
  },

  async readFile(tokens: OAuthTokens, path: string): Promise<FileReadResult> {
    const encoded = encodeURIComponent(path);
    const res = await graphFetch(tokens, `/me/drive/special/approot:/${encoded}:/content`);
    if (res.status === 404) return { content: null, etag: null };
    if (!res.ok) throw new Error(`OneDrive read failed (${res.status})`);
    const content = await res.text();

    // The download response does not always carry an ETag. Without one the next
    // write would skip optimistic concurrency and blind-overwrite a change made
    // on another device, so fall back to the item's metadata.
    let etag = res.headers.get("ETag");
    if (!etag) {
      const meta = await graphFetch(tokens, `/me/drive/special/approot:/${encoded}`);
      if (meta.ok) {
        const json = (await meta.json()) as { eTag?: string; etag?: string };
        etag = json.eTag ?? json.etag ?? null;
      }
    }
    return { content, etag };
  },

  async writeFile(tokens: OAuthTokens, path: string, content: string, etag: string | null): Promise<WriteResult> {
    const url = `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(path)}:/content`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.accessToken}`,
      "Content-Type": "application/octet-stream",
    };
    if (etag) headers["If-Match"] = etag;

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: content,
    });

    if (res.status === 409 || res.status === 412) {
      throw new OAuthError("Remote changed since last sync", "conflict");
    }
    if (res.status === 401) throw new OAuthError("access token expired", "token_expired");
    if (!res.ok) throw new Error(`OneDrive write failed (${res.status})`);

    const json = (await res.json()) as { eTag?: string; etag?: string };
    return { etag: json.eTag ?? json.etag ?? null };
  },

  async deleteFile(tokens: OAuthTokens, path: string): Promise<void> {
    const res = await graphFetch(
      tokens,
      `/me/drive/special/approot:/${encodeURIComponent(path)}:`
    );
    if (res.status === 404) return;
    if (res.status === 401) throw new OAuthError("access token expired", "token_expired");
    if (!res.ok && res.status !== 204) throw new Error(`OneDrive delete failed (${res.status})`);
  },

  async listFiles(tokens: OAuthTokens): Promise<{ name: string; etag: string | null }[]> {
    const res = await graphFetch(tokens, "/me/drive/special/approot/children");
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`OneDrive list failed (${res.status})`);
    const json = (await res.json()) as {
      value?: { name: string; eTag?: string; etag?: string }[];
    };
    return (json.value || []).map((f) => ({ name: f.name, etag: f.eTag ?? f.etag ?? null }));
  },
};

export { redirectUri as oneDriveRedirectUri };
