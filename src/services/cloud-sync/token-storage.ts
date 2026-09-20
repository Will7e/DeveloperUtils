// ============================================================
// Cloud Sync — Storage Tokens (vault-encrypted persistence)
// ============================================================
// OAuth tokens and provider metadata are encrypted with the
// device vault (AES-256-GCM) before being written to localStorage.
// They never leave the device in plaintext.

import { encrypt, decrypt, type CipherEnvelope } from "../crypto.service";
import { getPassphrase } from "../vault.service";
import type { CloudProviderId, OAuthTokens } from "./types";

const TOKEN_KEY_PREFIX = "intab_cloud_tokens_";
const LEGACY_PREFIX = "devutils_cloud_tokens_";

function storageKey(provider: CloudProviderId): string {
  return TOKEN_KEY_PREFIX + provider;
}

interface StoredTokenPayload {
  tokens: OAuthTokens;
  /** License fingerprint that created this connection (diagnostics) */
  licenseFp?: string;
}

/** Persists tokens encrypted with the device vault key. */
export async function saveTokens(
  provider: CloudProviderId,
  tokens: OAuthTokens,
  licenseFp?: string
): Promise<void> {
  const passphrase = getPassphrase();
  if (!passphrase) throw new Error("Vault unavailable — cannot store tokens securely");

  const payload: StoredTokenPayload = { tokens, licenseFp };
  const envelope: CipherEnvelope = await encrypt(JSON.stringify(payload), passphrase);
  localStorage.setItem(storageKey(provider), JSON.stringify(envelope));
}

/** Loads and decrypts stored tokens. Returns null when absent/corrupt. */
export async function loadTokens(provider: CloudProviderId): Promise<OAuthTokens | null> {
  const passphrase = getPassphrase();
  if (!passphrase) return null;

  try {
    const raw =
      localStorage.getItem(storageKey(provider)) ||
      localStorage.getItem(LEGACY_PREFIX + provider);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CipherEnvelope & { tokens?: OAuthTokens };
    if (typeof parsed.ct === "string" && typeof parsed.iv === "string") {
      const plaintext = await decrypt(parsed, passphrase);
      const payload = JSON.parse(plaintext) as StoredTokenPayload;
      if (payload.tokens?.accessToken) return payload.tokens;
      return null;
    }

    // Legacy plaintext fallback (should not happen, but be safe)
    if (parsed.tokens?.accessToken) return parsed.tokens;
    return null;
  } catch {
    return null;
  }
}

/** Removes stored tokens for a provider. */
export function clearTokens(provider: CloudProviderId): void {
  localStorage.removeItem(storageKey(provider));
  localStorage.removeItem(LEGACY_PREFIX + provider);
}

// ── ETag cache (per provider, plaintext — non-sensitive) ────

const ETAG_KEY_PREFIX = "intab_cloud_etag_";

export function saveEtag(provider: CloudProviderId, etag: string | null): void {
  try {
    if (etag) localStorage.setItem(ETAG_KEY_PREFIX + provider, etag);
    else localStorage.removeItem(ETAG_KEY_PREFIX + provider);
  } catch {
    /* storage full — etag cache is non-critical */
  }
}

export function loadEtag(provider: CloudProviderId): string | null {
  try {
    return localStorage.getItem(ETAG_KEY_PREFIX + provider);
  } catch {
    return null;
  }
}
