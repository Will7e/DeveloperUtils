// ============================================================
// Crypto Service — AES-256-GCM encryption via Web Crypto API
// ============================================================
// Zero dependencies — uses only browser-native Web Crypto.

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 600_000; // OWASP recommendation (2023+)

/** Encoded ciphertext envelope stored as JSON */
export interface CipherEnvelope {
  /** Base64-encoded ciphertext */
  ct: string;
  /** Base64-encoded IV */
  iv: string;
  /** Base64-encoded salt (used to derive the key) */
  salt: string;
  /** Version tag for future-proofing */
  v: 1;
}

// ── Helpers ──────────────────────────────────────────────────

export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function generateRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

// ── Key Derivation ──────────────────────────────────────────

/**
 * Derived-key cache. PBKDF2 at 600k iterations costs ~150ms+ of main-thread
 * time; without caching every single field decrypt re-ran the full KDF.
 * Keys are non-extractable CryptoKeys, so caching them is safe — the cache
 * never holds passphrase material.
 */
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();
const DERIVED_KEY_CACHE_MAX = 32;

/**
 * Derive an AES-256 key from a passphrase using PBKDF2 (cached).
 * Identical (passphrase, salt) pairs return the same derived key.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const cacheKey = `${passphrase}::${bufferToBase64(salt.buffer as ArrayBuffer)}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;

  const derivation = (async () => {
    const encoder = new TextEncoder();
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
        salt: salt as BufferSource,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: ALGORITHM, length: KEY_LENGTH },
      false, // not extractable
      ["encrypt", "decrypt"]
    );
  })();

  derivedKeyCache.set(cacheKey, derivation);
  if (derivedKeyCache.size > DERIVED_KEY_CACHE_MAX) {
    // Evict the oldest entry (insertion order)
    const oldest = derivedKeyCache.keys().next().value;
    if (oldest !== undefined) derivedKeyCache.delete(oldest);
  }
  return derivation;
}

/**
 * Deterministic per-passphrase salt (SHA-256 of a domain-separated
 * passphrase). The salt is not secret and adds no entropy — its job is to
 * make envelopes self-describing so `decrypt` derives the SAME key that
 * `encrypt` used and hits the cache, instead of re-running PBKDF2.
 * Cached per passphrase so repeated encrypts cost one digest each.
 */
const DETERMINISTIC_SALT_DOMAIN = "intab-envelope-salt-v1::";
const deterministicSaltCache = new Map<string, Promise<Uint8Array>>();

async function deterministicSalt(passphrase: string): Promise<Uint8Array> {
  let saltPromise = deterministicSaltCache.get(passphrase);
  if (!saltPromise) {
    saltPromise = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(DETERMINISTIC_SALT_DOMAIN + passphrase))
      .then((digest) => new Uint8Array(digest.slice(0, SALT_LENGTH)));
    deterministicSaltCache.set(passphrase, saltPromise);
  }
  return saltPromise;
}

/** Clears the derived-key cache (used on vault reset). */
export function clearDerivedKeyCache(): void {
  derivedKeyCache.clear();
  deterministicSaltCache.clear();
}

/**
 * Cached derivation for the transparent-storage master key. Same recipe as
 * `deriveKey`, but with a fixed domain-separated salt so every store adapter
 * derives the SAME key. Exists because `encrypted-storage.service` holds a
 * module-level `cachedMasterKeyPromise` that cannot be invalidated from the
 * crypto core — this route can (via `clearDerivedKeyCache` on vault reset).
 */
export async function deriveEnvelopeKey(passphrase: string): Promise<CryptoKey> {
  const salt = await deterministicSalt(passphrase);
  return deriveKey(passphrase, salt);
}

// ── Encrypt / Decrypt ───────────────────────────────────────

/**
 * Encrypt a plaintext string into a CipherEnvelope.
 * Each call generates a fresh random IV. The salt is deterministic per
 * passphrase so decryption resolves the cached derived key (see
 * `deterministicSalt`) — per-message secrecy comes from the fresh IV.
 */
export async function encrypt(
  plaintext: string,
  passphrase: string
): Promise<CipherEnvelope> {
  const salt = await deterministicSalt(passphrase);
  const iv = generateRandomBytes(IV_LENGTH);
  const key = await deriveKey(passphrase, salt);

  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: iv as BufferSource },
    key,
    encoder.encode(plaintext)
  );

  return {
    ct: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer as ArrayBuffer),
    salt: bufferToBase64(salt.buffer as ArrayBuffer),
    v: 1,
  };
}

/**
 * Decrypt a CipherEnvelope back to plaintext.
 * Throws if the passphrase is wrong or data is tampered with.
 */
export async function decrypt(
  envelope: CipherEnvelope,
  passphrase: string
): Promise<string> {
  const salt = new Uint8Array(base64ToBuffer(envelope.salt));
  const iv = new Uint8Array(base64ToBuffer(envelope.iv));
  const ciphertext = base64ToBuffer(envelope.ct);
  const key = await deriveKey(passphrase, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: iv as BufferSource },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

// ── Utilities ───────────────────────────────────────────────

/**
 * Check if a value looks like a CipherEnvelope (duck typing).
 */
export function isCipherEnvelope(value: unknown): value is CipherEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.ct === "string" &&
    typeof obj.iv === "string" &&
    typeof obj.salt === "string" &&
    obj.v === 1
  );
}

/**
 * Encrypt a JSON-serializable object's sensitive fields.
 * Non-sensitive fields are left as plaintext for searchability.
 */
export async function encryptFields<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: (keyof T)[],
  passphrase: string
): Promise<T> {
  const result = { ...obj };
  for (const key of sensitiveKeys) {
    const value = result[key];
    if (typeof value === "string" && value.trim() !== "") {
      (result as Record<string, unknown>)[key as string] = await encrypt(value, passphrase);
    }
  }
  return result;
}

/**
 * Decrypt a JSON object's sensitive fields (reverses encryptFields).
 */
export async function decryptFields<T extends Record<string, unknown>>(
  obj: T,
  sensitiveKeys: (keyof T)[],
  passphrase: string
): Promise<T> {
  const result = { ...obj };
  for (const key of sensitiveKeys) {
    const value = result[key];
    if (isCipherEnvelope(value)) {
      try {
        (result as Record<string, unknown>)[key as string] = await decrypt(value, passphrase);
      } catch {
        // If decryption fails (wrong passphrase), leave as empty string
        (result as Record<string, unknown>)[key as string] = "";
      }
    }
  }
  return result;
}

/**
 * Quick test to verify a passphrase can decrypt a known canary value.
 * Used during vault unlock to validate the passphrase before proceeding.
 */
export async function verifyPassphrase(
  canaryEnvelope: CipherEnvelope,
  passphrase: string,
  expectedCanary: string
): Promise<boolean> {
  try {
    const decrypted = await decrypt(canaryEnvelope, passphrase);
    return decrypted === expectedCanary;
  } catch {
    return false;
  }
}
