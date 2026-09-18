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
  type CipherEnvelope,
} from "./crypto.service";

// ── Constants ───────────────────────────────────────────────

const VAULT_META_KEY = "intab_vault_meta";
const LEGACY_VAULT_META_KEY = "devutils_vault_meta";
const DEVICE_SALT_KEY = "intab_device_id";
const LEGACY_DEVICE_SALT_KEY = "devutils_device_id";
const CANARY_PLAINTEXT = "intab-vault-canary-v2";

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
  resetVault: () => void;
  clearError: () => void;
  pokeActivity: () => void;
}

// ── Key Management ──────────────────────────────────────────

/**
 * Gets or creates a random device-unique salt stored in localStorage.
 * Ensures that even with identical .env secrets, each device has a unique key.
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === "undefined" || !window.localStorage) {
    return "server-static-device-id";
  }
  let id = localStorage.getItem(DEVICE_SALT_KEY) || localStorage.getItem(LEGACY_DEVICE_SALT_KEY);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  localStorage.setItem(DEVICE_SALT_KEY, id);
  return id;
}

/**
 * Generates the automatic master encryption key.
 * Combines VITE_VAULT_KEY (from .env) with the unique device salt.
 */
export function getAutomaticKey(): string {
  // Read VITE_VAULT_KEY from Vite environment, with resilient fallback
  const envKey =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (import.meta as any).env?.VITE_VAULT_KEY || "intab_sec_k9f2m8x4w1q7z5v3_vault";
  const deviceId = getOrCreateDeviceId();
  return `${envKey}:${deviceId}`;
}

/**
 * Returns the active passphrase for encryption / decryption.
 * In automatic transparent mode, this always returns the automatic device key.
 */
export function getPassphrase(): string | null {
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
      const autoKey = getAutomaticKey();

      // Check if there was an earlier vault (e.g. legacy devutils or version 1)
      const rawMeta = localStorage.getItem(VAULT_META_KEY) || localStorage.getItem(LEGACY_VAULT_META_KEY);
      if (rawMeta) {
        try {
          const meta = JSON.parse(rawMeta);
          // Check if encrypted with legacy default key
          const oldDefaultKey = `devutils_sec_k9f2m8x4w1q7z5v3_vault:${getOrCreateDeviceId()}`;
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

  resetVault: () => {
    // Clear all encrypted API tester data
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
      VAULT_META_KEY,
      LEGACY_VAULT_META_KEY,
      DEVICE_SALT_KEY,
      LEGACY_DEVICE_SALT_KEY,
    ];
    apiKeys.forEach((key) => localStorage.removeItem(key));

    // Generate fresh device ID
    getOrCreateDeviceId();

    // Re-initialize with new key
    const autoKey = getAutomaticKey();
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
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      const reEncrypted = await reEncryptDeep(data, oldPassphrase, newPassphrase);
      localStorage.setItem(key, JSON.stringify(reEncrypted));
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
