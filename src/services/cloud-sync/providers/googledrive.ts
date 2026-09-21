// ============================================================
// Cloud Sync — Google Drive Provider (appData folder)
// ============================================================
// Uses the `drive.appdata` scope — a hidden per-app folder users
// cannot see or accidentally delete. Google treats drive.appdata
// as a sensitive scope: the app ships unverified in production,
// which shows users a one-time warning screen during consent.

import type { CloudProvider, OAuthTokens, WriteResult } from "../types";
import { OAuthError } from "../oauth-error";
import {
  buildAuthorizeUrl,
  beginPkceFlow,
  refreshTokens,
  openOAuthPopup,
  waitForOAuthResult,
} from "../pkce";

const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || "";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

function redirectUri(): string {
  return `${window.location.origin}/oauth/callback.html`;
}

interface DriveFileInfo {
  id: string;
  headRevisionId?: string;
}

async function driveFetch(
  tokens: OAuthTokens,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`https://www.googleapis.com/${path.replace(/^\//, "")}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) throw new OAuthError("access token expired", "token_expired");
  return res;
}

/** Finds the appData sync file's metadata (id + revision). */
async function findSyncFile(tokens: OAuthTokens, name: string): Promise<DriveFileInfo | null> {
  const res = await driveFetch(
    tokens,
    `/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${name}'`)}&fields=files(id,headRevisionId)`
  );
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
  const json = (await res.json()) as { files?: DriveFileInfo[] };
  return json.files?.[0] ?? null;
}

export const googleDriveProvider: CloudProvider = {
  id: "googledrive",
  displayName: "Google Drive",

  async signIn(): Promise<OAuthTokens> {
    if (!CLIENT_ID) throw new Error("Google Drive sign-in is not configured (missing VITE_GOOGLE_CLIENT_ID).");

    const flow = beginPkceFlow({ clientId: CLIENT_ID, provider: "googledrive", scopes: SCOPES });
    const authorizeUrl = await buildAuthorizeUrl({
      provider: "googledrive",
      clientId: CLIENT_ID,
      redirectUri: redirectUri(),
      scopes: SCOPES,
      state: flow.state,
      verifier: flow.verifier,
    });

    await openOAuthPopup(authorizeUrl, "googledrive");

    // The callback page wrote the result to localStorage before closing.
    const result = await waitForOAuthResult(flow.state, 5000);

    if (!result.ok) throw new Error(result.error);

    const now = Date.now();
    const tokens: OAuthTokens = {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresAt: now + result.tokens.expiresIn * 1000,
      scope: result.tokens.scope,
      accountEmail: "",
      accountId: "",
      obtainedAt: now,
    };

    // Google Identity: fetch userinfo for a stable account label
    try {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (res.ok) {
        const info = (await res.json()) as { email?: string; sub?: string };
        tokens.accountEmail = info.email || "Google account";
        tokens.accountId = info.sub || tokens.accountEmail;
      }
    } catch {
      tokens.accountEmail = "Google account";
    }

    return tokens;
  },

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) throw new OAuthError("No refresh token available", "no_refresh_token");
    const refreshed = await refreshTokens({ provider: "googledrive", clientId: CLIENT_ID }, tokens.refreshToken);
    return {
      ...tokens,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
      scope: refreshed.scope || tokens.scope,
    };
  },

  async signOut(tokens: OAuthTokens | null): Promise<void> {
    // Best-effort revocation of the refresh token
    if (tokens?.refreshToken) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokens.refreshToken }),
        });
      } catch {
        /* best effort */
      }
    }
  },

  async readFile(tokens: OAuthTokens, path: string): Promise<string | null> {
    const meta = await findSyncFile(tokens, path);
    if (!meta) return null;
    const res = await driveFetch(tokens, `/drive/v3/files/${meta.id}?alt=media`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Drive read failed (${res.status})`);
    return res.text();
  },

  async writeFile(tokens: OAuthTokens, path: string, content: string, _etag: string | null): Promise<WriteResult> {
    void _etag; // Google Drive concurrency is handled via manifest rev compare in the sync engine
    const meta = await findSyncFile(tokens, path);

    // Update the existing appData file in place
    if (meta) {
      const updateRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${meta.id}?uploadType=media`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            "Content-Type": "application/octet-stream",
          },
          body: content,
        }
      );
      if (updateRes.status === 401) throw new OAuthError("access token expired", "token_expired");
      if (!updateRes.ok) throw new Error(`Drive update failed (${updateRes.status})`);
      const json = (await updateRes.json()) as { headRevisionId?: string };
      return { etag: json.headRevisionId ?? null };
    }

    // First upload: multipart create inside appDataFolder
    const createRes = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=headRevisionId",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "multipart/related; boundary=intab_sync_boundary",
        },
        body: buildMultipartBody(path, content),
      }
    );

    if (createRes.status === 401) throw new OAuthError("access token expired", "token_expired");
    if (!createRes.ok) throw new Error(`Drive write failed (${createRes.status})`);

    const created = (await createRes.json()) as { headRevisionId?: string };
    return { etag: created.headRevisionId ?? null };
  },

  async deleteFile(tokens: OAuthTokens, path: string): Promise<void> {
    const meta = await findSyncFile(tokens, path);
    if (!meta) return;
    const res = await driveFetch(tokens, `/drive/v3/files/${meta.id}`, { method: "DELETE" });
    if (res.status === 404) return;
    if (!res.ok && res.status !== 204) throw new Error(`Drive delete failed (${res.status})`);
  },

  async listFiles(tokens: OAuthTokens): Promise<{ name: string; etag: string | null }[]> {
    const res = await driveFetch(
      tokens,
      `/drive/v3/files?spaces=appDataFolder&fields=files(name,headRevisionId)`
    );
    if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
    const json = (await res.json()) as { files?: { name: string; headRevisionId?: string }[] };
    return (json.files || []).map((f) => ({ name: f.name, etag: f.headRevisionId ?? null }));
  },
};

/** Builds a multipart/related body for the Drive upload API. */
function buildMultipartBody(name: string, content: string): string {
  const metadata = JSON.stringify({
    name,
    parents: ["appDataFolder"],
  });
  return [
    "--intab_sync_boundary",
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    "--intab_sync_boundary",
    "Content-Type: application/octet-stream",
    "",
    content,
    "--intab_sync_boundary--",
  ].join("\r\n");
}

export { redirectUri as googleDriveRedirectUri };
