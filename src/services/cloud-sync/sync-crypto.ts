// ============================================================
// Cloud Sync — Portable Encryption (License-Derived Key)
// ============================================================
// Data uploaded to the cloud is encrypted with a key derived
// from the premium license key (PBKDF2 → AES-256-GCM), NOT the
// device vault key. The vault key is device-salted and cannot
// be reproduced on another device; the license key can.

import {
  deriveKey,
  bufferToBase64,
  base64ToBuffer,
  generateRandomBytes,
  type CipherEnvelope,
} from "../crypto.service";

const SYNC_KEY_INFO = "intab-cloud-sync-v1";
const SYNC_KEY_SALT = "intab-sync-fixed-salt-v1";
/**
 * App pepper mixed into the default sync key. Derived together with the
 * connected account id so cloud files are never stored in plaintext, while
 * anyone with the app (and the user's own drive OAuth grant) can still read
 * them — this is encryption at rest, NOT cross-user E2E. A valid license
 * key upgrades to true E2E: the key derives from the license, so only
 * devices holding the same license can decrypt.
 */
const SYNC_DEFAULT_PEPPER = "intab-sync-at-rest-pepper-v1";

let cachedKey: CryptoKey | null = null;
let cachedKeyFor: string | null = null;

/**
 * Derives (and caches) the portable AES-256-GCM key from the license key.
 * Same license key → same key on every device → cross-device decryption.
 */
export async function getSyncCryptoKey(licenseKey: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeyFor === licenseKey) return cachedKey;
  cachedKey = await deriveKey(
    `${SYNC_KEY_INFO}:${licenseKey}`,
    new TextEncoder().encode(SYNC_KEY_SALT)
  );
  cachedKeyFor = licenseKey;
  return cachedKey;
}

/**
 * Default (always-on) sync key: pepper + connected account id.
 * Used when no E2E license is present so snapshots are always encrypted
 * at rest in the drive's hidden app folder.
 */
export function getDefaultSyncKey(accountId: string): string {
  return `${SYNC_DEFAULT_PEPPER}:${accountId || "anonymous"}`;
}

/** Clears the cached derived key (on disconnect / license change). */
export function clearSyncCryptoKey(): void {
  cachedKey = null;
  cachedKeyFor = null;
}

/** Non-secrecy fingerprint of a sync key, safe to store/compare. */
export async function licenseFingerprint(licenseKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(licenseKey));
  return bufferToBase64(digest).slice(0, 12);
}

/**
 * Tagged sync envelope: the CipherEnvelope plus a non-secret key id so a
 * reader can tell WHICH key encrypted the blob (license vs default at-rest
 * key) and fail with a clear error instead of an opaque crypto failure.
 */
export interface TaggedSyncEnvelope {
  /** Non-secret fingerprint of the sync key used */
  kid: string;
  envelope: CipherEnvelope;
}

/** Serializes a payload encrypted with `syncKey`, tagged with its key id. */
export async function encryptSnapshotTagged(
  data: unknown,
  syncKey: string
): Promise<string> {
  const kid = await licenseFingerprint(syncKey);
  const envelopeJson = await encryptSnapshot(data, syncKey);
  return JSON.stringify({ kid, envelope: JSON.parse(envelopeJson) } satisfies TaggedSyncEnvelope);
}

/** Decrypts a tagged envelope, verifying the key id matches. */
export async function decryptSnapshotTagged<T>(
  taggedJson: string,
  syncKey: string
): Promise<T> {
  const tagged = JSON.parse(taggedJson) as TaggedSyncEnvelope;
  const kid = await licenseFingerprint(syncKey);
  if (tagged.kid && tagged.kid !== kid) {
    throw new Error(
      `Snapshot was encrypted with a different key (${tagged.kid.slice(0, 6)}…). ` +
        `If a license key changed recently, use the same key on this device.`
    );
  }
  return decryptSnapshot<T>(JSON.stringify(tagged.envelope), syncKey);
}

/**
 * Encrypts a JSON-serializable payload into a serialized CipherEnvelope.
 * Uses the sync crypto key with a fresh IV + salt each call.
 */
export async function encryptSnapshot(data: unknown, licenseKey: string): Promise<string> {
  const key = await getSyncCryptoKey(licenseKey);
  const iv = generateRandomBytes(12);
  const encoder = new TextEncoder();

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoder.encode(JSON.stringify(data))
  );

  const envelope: CipherEnvelope = {
    ct: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer as ArrayBuffer),
    salt: bufferToBase64(new TextEncoder().encode(SYNC_KEY_SALT).slice(0, 16).buffer as ArrayBuffer),
    v: 1,
  };
  return JSON.stringify(envelope);
}

/** Decrypts a serialized CipherEnvelope back into the payload. Throws on tamper. */
export async function decryptSnapshot<T>(envelopeJson: string, licenseKey: string): Promise<T> {
  const key = await getSyncCryptoKey(licenseKey);
  const envelope = JSON.parse(envelopeJson) as CipherEnvelope;
  const iv = new Uint8Array(base64ToBuffer(envelope.iv));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    base64ToBuffer(envelope.ct)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
