// ============================================================
// Encrypted Storage Service — High-Performance AES-256-GCM Storage
// ============================================================
// Transparently encrypts all persisted store data at rest in localStorage
// using native Web Crypto AES-256-GCM with cached master key derivation.
// Zero UI lag (<0.1ms encryption) and automatic migration for existing data.

import type { StateStorage } from "zustand/middleware";
import {
  bufferToBase64,
  base64ToBuffer,
  generateRandomBytes,
  isCipherEnvelope,
  deriveEnvelopeKey,
  type CipherEnvelope,
} from "./crypto.service";
import { getAutomaticKey, getOrCreateDeviceId } from "./vault.service";
import { readValue, writeValue } from "./idb-storage.service";

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM

/**
 * Placeholder for the envelope's `salt` field. The real per-device salt is
 * what the master key is derived from and must never be written next to the
 * ciphertext it protects (that would hand an attacker the missing half of the
 * KDF input). The field is retained so `isCipherEnvelope` and older readers
 * keep working; decrypt derives from the device id, not from this value.
 */
const ENVELOPE_SALT_MARKER = "intab-envelope-v1";

let cachedMasterKeyPromise: Promise<CryptoKey> | null = null;

/**
 * Derives and caches the master AES-256-GCM CryptoKey.
 * Routes through the shared cached derivation in crypto.service so the
 * expensive PBKDF2 run happens exactly once per session — subsequent
 * encrypt/decrypt calls are sub-millisecond.
 */
export async function getMasterCryptoKey(): Promise<CryptoKey> {
  if (!cachedMasterKeyPromise) {
    cachedMasterKeyPromise = deriveEnvelopeKey(await getAutomaticKey()).catch((err) => {
      cachedMasterKeyPromise = null;
      throw err;
    });
  }
  return cachedMasterKeyPromise;
}

/**
 * Legacy master-key derivation (pre-cache builds): 100k iterations over a
 * deviceId-padded salt. Kept ONLY so envelopes written by older builds can
 * still be decrypted and transparently migrated; new writes never use it.
 */
async function getLegacyMasterCryptoKey(): Promise<CryptoKey> {
  const passphrase = await getAutomaticKey();
  const deviceId = await getOrCreateDeviceId();
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode(deviceId.padEnd(16, "0")).slice(0, 16);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes as BufferSource,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Thrown when plaintext cannot be encrypted. Callers must NOT persist their
 * payload in the clear in response — an unencrypted write is worse than a
 * skipped one, because nothing downstream can tell the difference.
 */
export class EncryptionUnavailableError extends Error {
  readonly code = "encryption_unavailable";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}

/**
 * Encrypts a plaintext string into a serialized CipherEnvelope.
 * Generates a fresh cryptographically random 96-bit IV for every call.
 *
 * Throws (rather than returning the plaintext) when encryption is not
 * possible: a silent plaintext fallback used to write the whole store in the
 * clear — e.g. in a non-secure context where `crypto.subtle` is undefined —
 * with no signal to the user.
 */
export async function encryptState(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.trim() === "") return plaintext;

  try {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error("Web Crypto unavailable (insecure context?)");
    }
    const key = await getMasterCryptoKey();
    const iv = generateRandomBytes(IV_LENGTH);
    const encoder = new TextEncoder();

    const ciphertext = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      encoder.encode(plaintext)
    );

    const envelope: CipherEnvelope = {
      ct: bufferToBase64(ciphertext),
      iv: bufferToBase64(iv.buffer as ArrayBuffer),
      salt: ENVELOPE_SALT_MARKER,
      v: 1,
    };

    return JSON.stringify(envelope);
  } catch (err) {
    throw new EncryptionUnavailableError(
      "Could not encrypt data before persisting it",
      err
    );
  }
}

/**
 * Decrypts raw storage content.
 * Tries the current master key, then the legacy pre-cache key (envelopes
 * written by older builds), then passes legacy plaintext through unharmed.
 * Returns null when the payload is a well-formed envelope that no known key
 * can open — the caller must then treat the store as empty instead of
 * rehydrating the envelope itself as if it were state.
 */
export async function decryptState(rawStorage: string): Promise<string | null> {
  if (!rawStorage || rawStorage.trim() === "") return rawStorage;

  let parsed: CipherEnvelope;
  try {
    const json = JSON.parse(rawStorage);
    if (!isCipherEnvelope(json)) return rawStorage;
    parsed = json;
  } catch {
    // Not JSON — legacy plaintext, pass through
    return rawStorage;
  }

  // Decode inside a guard: a truncated write or corrupted record can leave an
  // envelope whose base64 no longer parses, and atob throws on that. Throwing
  // out of a storage read would break rehydration; treat it as unreadable.
  let iv: Uint8Array;
  let ciphertext: ArrayBuffer;
  try {
    iv = new Uint8Array(base64ToBuffer(parsed.iv));
    ciphertext = base64ToBuffer(parsed.ct);
  } catch {
    console.warn("Stored envelope was malformed — treating it as empty");
    return null;
  }

  try {
    const key = await getMasterCryptoKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    // Current key failed — try the legacy derivation before giving up
  }

  try {
    const legacyKey = await getLegacyMasterCryptoKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv as BufferSource },
      legacyKey,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    // Unreadable with any known key. Never hand the envelope back as if it
    // were state: zustand would merge `{ct,iv,salt,v}` over the store.
    console.warn(
      "Stored data could not be decrypted with this device key — treating it as empty (vault reset or a different profile?)"
    );
    return null;
  }
}

/**
 * Detects if an error is a browser storage quota exceeded exception.
 */
export function isQuotaExceededError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      err.code === 22 ||
      err.code === 1014)
  );
}

export interface StorageUsageStats {
  usedBytes: number;
  usedFormatted: string;
  quotaBytes: number;
  quotaFormatted: string;
  percentage: number;
  isNearLimit: boolean;
}

/**
 * Calculates current localStorage utilization (legacy fallback path for
 * browsers without the Storage Manager API).
 */
export function getLocalStorageUsage(): StorageUsageStats {
  const quotaBytes = 5 * 1024 * 1024; // 5 MB typical browser quota
  if (typeof window === "undefined" || !window.localStorage) {
    return {
      usedBytes: 0,
      usedFormatted: "0 KB",
      quotaBytes,
      quotaFormatted: "5.0 MB",
      percentage: 0,
      isNearLimit: false,
    };
  }

  let totalChars = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key) {
      totalChars += key.length + (window.localStorage.getItem(key)?.length || 0);
    }
  }

  // UTF-16 strings consume 2 bytes per char
  const usedBytes = totalChars * 2;
  const percentage = Math.min(100, Math.round((usedBytes / quotaBytes) * 100));

  return {
    usedBytes,
    usedFormatted: formatBytes(usedBytes),
    quotaBytes,
    quotaFormatted: "5.0 MB",
    percentage,
    isNearLimit: percentage >= 80,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Returns real storage utilization via the Storage Manager API. Heavy data
 * now lives in IndexedDB, so usage is origin-wide (IndexedDB + localStorage
 * + caches) against the browser's disk-based quota — no fixed 5MB ceiling.
 * Falls back to a localStorage-only estimate when the API is unavailable.
 */
export async function getStorageUsage(): Promise<StorageUsageStats> {
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      if (quota > 0) {
        const percentage = Math.min(100, Math.round((usage / quota) * 100));
        return {
          usedBytes: usage,
          usedFormatted: formatBytes(usage),
          quotaBytes: quota,
          quotaFormatted: formatBytes(quota),
          percentage,
          isNearLimit: percentage >= 80,
        };
      }
    } catch {
      /* fall through to the localStorage estimate */
    }
  }
  return getLocalStorageUsage();
}

/**
 * Called when the vault is reset: forgets the cached master key so the next
 * read derives from the NEW device id. In-flight promises resolve with the old
 * key; envelopes sealed with it are wiped by the same reset, and any that
 * survive undecryptable are treated as empty rather than rehydrated as state.
 */
export function resetMasterKeyCache(): void {
  cachedMasterKeyPromise = null;
}

// ── Coalesced write queue (module-level, one per document) ───
//
// A single queue + a single pair of unload listeners is shared by every
// adapter. Previously each `createEncryptedStorage()` call carried its own
// timer, its own single-slot payload and its own listeners: two keys through
// one adapter silently dropped the first write, and one-shot readers that
// built an adapter (the cloud-sync snapshot collector, on every pull) leaked a
// listener pair each time.

const WRITE_COALESCE_MS = 60;

/** name → pending plaintext; null means "delete this key". */
const pendingWrites = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushListenersAttached = false;
let lastQuotaAlertTime = 0;

function dispatchStorageEvent(type: string, error: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(type, { detail: { error } }));
}

function reportWriteFailure(name: string, err: unknown): void {
  if (isQuotaExceededError(err)) {
    const now = Date.now();
    // Throttle alert to once every 10 seconds to avoid spamming the user
    if (now - lastQuotaAlertTime > 10_000) {
      lastQuotaAlertTime = now;
      dispatchStorageEvent("intab:storage-quota-exceeded", err);
    }
  } else {
    // The write was dropped rather than persisted in the clear. Surface it so
    // the user learns their data is not being saved instead of finding out on
    // the next reload.
    dispatchStorageEvent("intab:storage-write-failed", err);
  }
  console.warn(`Storage save note (${name}):`, err);
}

/** Encrypts and persists a single coalesced payload. Never throws. */
async function writeOne(name: string, value: string | null): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (value === null) {
      await writeValue(name, null);
      return;
    }
    const encrypted = await encryptState(value);
    await writeValue(name, encrypted);
  } catch (err) {
    reportWriteFailure(name, err);
  }
}

/**
 * Persists every queued write immediately. Used by the unload/hide handlers
 * and by the cloud-sync engine, which needs storage to have settled before it
 * can tell a real local edit from the churn caused by applying a snapshot.
 */
export async function flushEncryptedWrites(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingWrites.size === 0) return;
  const batch = Array.from(pendingWrites.entries());
  pendingWrites.clear();
  await Promise.all(batch.map(([name, value]) => writeOne(name, value)));
}

function scheduleFlush(): void {
  // Micro-coalescing to prevent unnecessary disk writes during rapid typing
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushEncryptedWrites();
  }, WRITE_COALESCE_MS);
}

/**
 * Registers the unload/hide flush handlers exactly once per document.
 * IndexedDB writes need the page alive: flush when the tab hides or starts
 * unloading instead of waiting for beforeunload. Best-effort — an instant
 * close can still lose the last ~60ms of coalesced writes.
 */
function attachFlushListeners(): void {
  if (flushListenersAttached || typeof window === "undefined") return;
  flushListenersAttached = true;
  window.addEventListener("pagehide", () => {
    void flushEncryptedWrites();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushEncryptedWrites();
  });
}

/**
 * Reads a persisted encrypted value without registering unload handlers or a
 * write queue. One-shot readers (the cloud-sync snapshot collector) use this
 * instead of constructing a full storage adapter.
 *
 * Pending writes win over what is on disk: a value that has not been flushed
 * yet is still the newest one this tab knows about.
 */
export async function readEncryptedValue(name: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (pendingWrites.has(name)) return pendingWrites.get(name) ?? null;
  const raw = await readValue(name);
  if (raw === null || raw === "") return null;
  return decryptState(raw);
}

/**
 * Creates a Zustand StateStorage adapter with AES-256-GCM encryption at rest
 * and coalesced writes. Cheap to call repeatedly: all state lives in the
 * module-level queue above.
 */
export function createEncryptedStorage(): StateStorage {
  attachFlushListeners();

  return {
    getItem: async (name: string): Promise<string | null> => readEncryptedValue(name),

    setItem: async (name: string, value: string): Promise<void> => {
      pendingWrites.set(name, value);
      scheduleFlush();
    },

    removeItem: async (name: string): Promise<void> => {
      // Deletions take effect immediately and supersede any queued value.
      pendingWrites.set(name, null);
      await flushEncryptedWrites();
    },
  };
}
