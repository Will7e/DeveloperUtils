// ============================================================
// Vault Service — Automatic Transparent Encryption for InTab
// ============================================================
// Seamlessly encrypts sensitive data (tokens, passwords, headers,
// environment secrets) at rest using AES-256-GCM without requiring
// manual user passphrases.
// Derives the encryption key from .env (VITE_VAULT_KEY) + device salt.

import { create } from "zustand";
import {
  encrypt,
  decrypt,
  verifyPassphrase,
  isCipherEnvelope,
  clearDerivedKeyCache,
  type CipherEnvelope,
} from "./crypto.service";
import { resetMasterKeyCache } from "./encrypted-storage.service";
import {
  acquireDeviceSalt,
  readValue,
  writeValue,
  removeIdbKeys,
  removeIdbKeysByPrefix,
  resetIdbFallbackMarkers,
} from "./idb-storage.service";

// ── Constants ───────────────────────────────────────────────

const VAULT_META_KEY = "intab_vault_meta";
const LEGACY_VAULT_META_KEY = "devutils_vault_meta";
const DEVICE_SALT_KEY = "intab_device_id";
const LEGACY_DEVICE_SALT_KEY = "devutils_device_id";
const CANARY_PLAINTEXT = "intab-vault-canary-v2";

// Keys of the encrypted zustand stores and the agent workspace family. Kept
// here (not imported) because the vault is the lowest layer and must not
// depend on the stores it protects.
const APP_STATE_KEY = "intab-app-state";
const CHAT_STATE_KEY = "intab_chat_state";
const WORKSPACE_IDB_KEY_PREFIX = "intab_workspace_";

interface VaultMeta {
  canary: CipherEnvelope;
  createdAt: number;
  mode: "automatic";
  version: 2;
}

export interface VaultState {
  /** Whether vault is initialized and active */
  isSetup: boolean;
  /** Always true in transparent mode */
  isUnlocked: boolean;
  /** Mode */
  mode: "automatic";
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: string | null;

  // ── Actions ──────────────────────────────────────────────
  initAutomaticVault: () => Promise<void>;
  checkSetup: () => void;
  resetVault: () => Promise<void>;
  clearError: () => void;
  pokeActivity: () => void;
}

// ── Key Management ──────────────────────────────────────────

/**
 * Gets or creates a random device-unique salt stored in IndexedDB —
 * alongside the ciphertext it protects, so "clear site data" always
 * removes key and data together. Falls back to the legacy localStorage
 * key when IDB is unavailable, keeping fallback-mode data decryptable.
 *
 * Singleton promise + atomic acquire: concurrent first-boot tabs each
 * run the acquire exactly once, and IndexedDB serializes the
 * check-and-set so every tab converges on a single salt instead of
 * racing into mismatched keys. Ensures that even with identical .env
 * secrets, each device has a unique key.
 */
let deviceIdPromise: Promise<string> | null = null;

function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getOrCreateDeviceId(): Promise<string> {
  if (typeof window === "undefined") {
    return Promise.resolve("server-static-device-id");
  }
  if (!deviceIdPromise) {
    const promise = (async () => {
      let legacy: string | null = null;
      try {
        legacy =
          localStorage.getItem(DEVICE_SALT_KEY) || localStorage.getItem(LEGACY_DEVICE_SALT_KEY);
      } catch {
        /* storage unavailable — start from scratch */
      }
      try {
        return await acquireDeviceSalt(DEVICE_SALT_KEY, legacy, generateSalt);
      } catch (err) {
        console.warn("Device salt IDB access failed, using localStorage:", err);
        const id = legacy ?? generateSalt();
        try {
          localStorage.setItem(DEVICE_SALT_KEY, id);
        } catch {
          /* nothing more we can do */
        }
        return id;
      }
    })();
    deviceIdPromise = promise;
    promise.catch(() => {
      // Allow a retry on the next call after an unexpected rejection.
      if (deviceIdPromise === promise) deviceIdPromise = null;
    });
  }
  return deviceIdPromise;
}

/**
 * Generates the automatic master encryption key.
 * Combines VITE_VAULT_KEY (from .env) with the unique device salt.
 */
export async function getAutomaticKey(): Promise<string> {
  // Read VITE_VAULT_KEY from Vite environment, with resilient fallback
  const envKey =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (import.meta as any).env?.VITE_VAULT_KEY || "intab_sec_k9f2m8x4w1q7z5v3_vault";
  const deviceId = await getOrCreateDeviceId();
  return `${envKey}:${deviceId}`;
}

/**
 * Returns the active passphrase for encryption / decryption.
 * In automatic transparent mode, this always returns the automatic device key.
 */
export async function getPassphrase(): Promise<string | null> {
  return getAutomaticKey();
}

// ── Store ───────────────────────────────────────────────────

export const useVaultStore = create<VaultState>((set) => ({
  isSetup: true,
  isUnlocked: true,
  mode: "automatic",
  isLoading: false,
  error: null,

  checkSetup: () => {
    set({ isSetup: true, isUnlocked: true });
  },

  initAutomaticVault: async () => {
    try {
      const autoKey = await getAutomaticKey();

      // Check if there was an earlier vault (e.g. legacy devutils or version 1)
      const rawMeta = localStorage.getItem(VAULT_META_KEY) || localStorage.getItem(LEGACY_VAULT_META_KEY);
      if (rawMeta) {
        try {
          const meta = JSON.parse(rawMeta);
          // Check if encrypted with legacy default key
          const oldDefaultKey = `devutils_sec_k9f2m8x4w1q7z5v3_vault:${await getOrCreateDeviceId()}`;
          if (oldDefaultKey !== autoKey && meta?.canary) {
            const isOldDefaultPass = await verifyPassphrase(meta.canary, oldDefaultKey, "devutils-vault-canary-v2");
            if (isOldDefaultPass) {
              await reEncryptAllData(oldDefaultKey, autoKey);
            }
          }
          // If old canary exists and was encrypted with test passphrase "MySecurePass123!"
          if (meta?.canary && meta.version === 1) {
            const isTestPass = await verifyPassphrase(meta.canary, "MySecurePass123!", "devutils-vault-canary-v1");
            if (isTestPass) {
              // Re-encrypt from test passphrase to automatic key
              await reEncryptAllData("MySecurePass123!", autoKey);
            }
          }
        } catch {
          // Ignore invalid meta
        }
      }

      // Save updated automatic canary
      const canary = await encrypt(CANARY_PLAINTEXT, autoKey);
      const newMeta: VaultMeta = {
        canary,
        createdAt: Date.now(),
        mode: "automatic",
        version: 2,
      };
      localStorage.setItem(VAULT_META_KEY, JSON.stringify(newMeta));

      set({ isSetup: true, isUnlocked: true, isLoading: false, error: null });
    } catch (e) {
      console.warn("Auto vault initialization notice:", e);
      set({ isSetup: true, isUnlocked: true, isLoading: false });
    }
  },

  resetVault: async () => {
    // Rotating the device key invalidates EVERY envelope it produced, so the
    // wipe has to cover every vault-scoped store — not just the API tester.
    // Anything left behind stays on disk as undecryptable ciphertext that
    // still looks intact (and, in the zustand stores' case, used to be
    // rehydrated as garbage). State still held in memory is re-encrypted with
    // the fresh key on the next write, so nothing live is lost here.
    const apiKeys = [
      "intab_api_tabs",
      "intab_api_history",
      "intab_api_collections",
      "intab_api_env_vars",
      "intab_api_environments",
      "intab_api_active_env",
      "intab_api_custom_presets",
      "intab_api_added_preset_ids",
      "intab_api_custom_proxy",
      "devutils_api_tabs",
      "devutils_api_history",
      "devutils_api_collections",
      "devutils_api_env_vars",
      "devutils_api_environments",
      "devutils_api_active_env",
      "devutils_api_custom_presets",
      "devutils_api_added_preset_ids",
      "devutils_api_custom_proxy",
      // Encrypted zustand stores (editor/app state + AI chat)
      APP_STATE_KEY,
      "devutils-app-state",
      CHAT_STATE_KEY,
      "devutils_chat_state",
      // Sync-side state keyed off the same device key
      "intab_cloud_manifest_cache",
      "intab_cloud_last_synced_sig",
      "intab_cloudsync_presence",
      VAULT_META_KEY,
      LEGACY_VAULT_META_KEY,
      DEVICE_SALT_KEY,
      LEGACY_DEVICE_SALT_KEY,
    ];
    apiKeys.forEach((key) => localStorage.removeItem(key));

    // Prefix sweep: OAuth handoffs, vault-encrypted OAuth tokens, their etag
    // cache, and per-conversation agent workspaces. All of these were sealed
    // with the key we are discarding.
    try {
      const doomedPrefixes = [
        "intab_oauth_handoff_",
        "intab_oauth_result_",
        "intab_cloud_tokens_",
        "devutils_cloud_tokens_",
        "intab_cloud_etag_",
        WORKSPACE_IDB_KEY_PREFIX,
      ];
      const doomed: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && doomedPrefixes.some((p) => k.startsWith(p))) doomed.push(k);
      }
      doomed.forEach((k) => localStorage.removeItem(k));
    } catch {
      /* storage unavailable — nothing to sweep */
    }

    // Wipe IDB copies: the device salt AND the heavy data that moved off
    // localStorage. The salt MUST die with the data, or leftover ciphertext
    // would be silently re-keyed (undecryptable) while looking intact.
    await removeIdbKeys([
      DEVICE_SALT_KEY,
      "intab_api_tabs",
      "intab_api_history",
      "intab_api_collections",
      "intab_api_env_vars",
      "intab_api_environments",
      "intab_api_active_env",
      "intab_api_custom_presets",
      "intab_api_added_preset_ids",
      "intab_api_custom_proxy",
      APP_STATE_KEY,
      CHAT_STATE_KEY,
      "intab_cloud_manifest_cache",
      "intab_cloud_last_synced_sig",
    ]);
    await removeIdbKeysByPrefix([WORKSPACE_IDB_KEY_PREFIX]);
    resetIdbFallbackMarkers();

    // Generate fresh device ID
    deviceIdPromise = null;
    await getOrCreateDeviceId();

    // CRITICAL: forget every cached derived key (they were bound to the old
    // device id). Without this, the session keeps encrypting with the OLD key
    // while fresh readers derive the NEW one — silent data loss.
    clearDerivedKeyCache();
    resetMasterKeyCache();

    // Re-initialize with new key
    const autoKey = await getAutomaticKey();
    encrypt(CANARY_PLAINTEXT, autoKey).then((canary) => {
      const newMeta: VaultMeta = {
        canary,
        createdAt: Date.now(),
        mode: "automatic",
        version: 2,
      };
      localStorage.setItem(VAULT_META_KEY, JSON.stringify(newMeta));
    });

    set({ isSetup: true, isUnlocked: true, error: null });
  },

  clearError: () => {
    set({ error: null });
  },

  pokeActivity: () => {
    // No-op in automatic mode (no lock timeout)
  },
}));

// ── Re-encryption helper ────────────────────────────────────

async function reEncryptAllData(
  oldPassphrase: string,
  newPassphrase: string
): Promise<void> {
  const keys = [
    "intab_api_tabs",
    "intab_api_history",
    "intab_api_collections",
    "intab_api_env_vars",
    "intab_api_environments",
    "intab_api_custom_presets",
    "devutils_api_tabs",
    "devutils_api_history",
    "devutils_api_collections",
    "devutils_api_env_vars",
    "devutils_api_environments",
    "devutils_api_custom_presets",
  ];

  for (const key of keys) {
    // readValue/writeValue span both IDB and the localStorage fallback
    // (heavy keys moved off localStorage but may still exist there).
    const raw = await readValue(key);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      const reEncrypted = await reEncryptDeep(data, oldPassphrase, newPassphrase);
      await writeValue(key, JSON.stringify(reEncrypted));
    } catch {
      console.warn(`Skipping re-encryption for ${key}`);
    }
  }
}

async function reEncryptDeep(
  value: unknown,
  oldPassphrase: string,
  newPassphrase: string
): Promise<unknown> {
  if (isCipherEnvelope(value)) {
    try {
      const plaintext = await decrypt(value, oldPassphrase);
      return encrypt(plaintext, newPassphrase);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item) => reEncryptDeep(item, oldPassphrase, newPassphrase))
    );
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = await reEncryptDeep(v, oldPassphrase, newPassphrase);
    }
    return result;
  }

  return value;
}
