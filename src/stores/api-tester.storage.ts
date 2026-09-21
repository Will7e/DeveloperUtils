import { TabState, HistoryItem, ImportedCollection, Environment, KeyValueField, AuthConfig } from "./api-tester.store";
import type { LibraryPreset } from "@/features/api-tester/data/preset-library.data";
import { encrypt, decrypt, isCipherEnvelope, type CipherEnvelope } from "@/services/crypto.service";
import { getPassphrase } from "@/services/vault.service";
import { readValue, writeValue, writeValueToIdb } from "@/services/idb-storage.service";

export interface StorageAdapter {
  getTabs(): Promise<{ tabs: TabState[]; activeTabId: string } | null>;
  saveTabs(tabs: TabState[], activeTabId: string): Promise<void>;

  getHistory(): Promise<HistoryItem[]>;
  saveHistory(history: HistoryItem[]): Promise<void>;

  getCollections(): Promise<ImportedCollection[]>;
  saveCollections(collections: ImportedCollection[]): Promise<void>;

  getEnvVars(): Promise<KeyValueField[]>;
  saveEnvVars(vars: KeyValueField[]): Promise<void>;

  getEnvironments(): Promise<Environment[]>;
  saveEnvironments(envs: Environment[]): Promise<void>;

  getActiveEnvId(): Promise<string | null>;
  saveActiveEnvId(id: string | null): Promise<void>;

  getCustomPresets(): Promise<LibraryPreset[]>;
  saveCustomPresets(presets: LibraryPreset[]): Promise<void>;

  getAddedPresetIds(): Promise<string[]>;
  saveAddedPresetIds(ids: string[]): Promise<void>;

  getCustomProxyUrl(): Promise<string | null>;
  saveCustomProxyUrl(url: string | null): Promise<void>;
}

// ── Sensitive field definitions ─────────────────────────────
// These are the fields that contain secrets and MUST be encrypted.

const AUTH_CONFIG_SENSITIVE_KEYS: (keyof AuthConfig)[] = [
  "bearerToken",
  "basicUsername",
  "basicPassword",
  "apiKeyName",
  "apiKeyValue",
];

// ── Encryption helpers ──────────────────────────────────────

async function encryptString(value: string, passphrase: string): Promise<CipherEnvelope | string> {
  if (!value || value.trim() === "") return value;
  return encrypt(value, passphrase);
}

async function decryptString(value: unknown, passphrase: string): Promise<string> {
  if (isCipherEnvelope(value)) {
    try {
      return await decrypt(value, passphrase);
    } catch {
      // Decryption failed. Remember WHICH envelope failed so a later save can
      // refuse to overwrite it with a blank (see writePreservingSecrets) —
      // otherwise the next save silently destroyed the credential.
      noteUnreadableEnvelope(value);
      return "";
    }
  }
  return typeof value === "string" ? value : "";
}

// ── Unreadable-envelope preservation ────────────────────────
//
// A decrypt failure (rotated device key, restored backup, storage split) used
// to surface as an empty string, and the next save re-encrypted that empty
// string over the still-valid envelope — irreversibly destroying the secret.
// Envelopes that failed to decrypt are tracked by ciphertext, and a save will
// keep those exact envelopes rather than blank them. An intentional clear is
// unaffected: the field the user cleared decrypted fine, so its ciphertext is
// not in the set.

const unreadableCiphertexts = new Set<string>();
const UNREADABLE_CIPHERTEXT_MAX = 512;

function noteUnreadableEnvelope(envelope: CipherEnvelope): void {
  // Bounded: the set only ever holds one entry per distinct unreadable secret.
  if (unreadableCiphertexts.size >= UNREADABLE_CIPHERTEXT_MAX) return;
  unreadableCiphertexts.add(envelope.ct);
}

function isBlankValue(value: unknown): boolean {
  return value === "" || value === null || value === undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively keeps previously stored envelopes that `next` would blank out. */
function mergePreservingEnvelopes(previous: unknown, next: unknown): unknown {
  if (isCipherEnvelope(previous) && isBlankValue(next) && unreadableCiphertexts.has(previous.ct)) {
    return previous;
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    // Only align positionally when the shapes still match; any structural edit
    // means we cannot know which previous row a value belonged to.
    if (previous.length !== next.length) return next;
    return next.map((item, i) => mergePreservingEnvelopes(previous[i], item));
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const merged: Record<string, unknown> = { ...next };
    for (const key of Object.keys(next)) {
      merged[key] = mergePreservingEnvelopes(previous[key], next[key]);
    }
    return merged;
  }
  return next;
}

/**
 * Persists a value while rescuing any envelope the write would blank out.
 * Reads the currently stored copy first so the previous envelopes are known.
 */
async function writePreservingSecrets(
  storageKey: string,
  legacyKey: string,
  value: unknown
): Promise<void> {
  let toWrite = value;
  if (unreadableCiphertexts.size > 0) {
    try {
      const previousRaw = await getStoredItemAsync(storageKey, legacyKey);
      if (previousRaw) {
        toWrite = mergePreservingEnvelopes(JSON.parse(previousRaw), value);
      }
    } catch {
      // Unreadable/absent previous copy — write the new value as-is.
    }
  }
  await writeValue(storageKey, JSON.stringify(toWrite));
}

/**
 * Persists a migrated (now encrypted) payload and drops the plaintext legacy
 * copies. Writing through the IDB-aware path matters: these keys moved to
 * IndexedDB, so the previous localStorage-only write was shadowed by the
 * still-plaintext IDB copy — the migration reported success and encrypted
 * nothing. The plaintext copies are only removed once the encrypted copy is
 * actually stored (in IDB, or in localStorage when IDB is unavailable).
 */
async function persistMigrated(key: string, legacyKey: string, value: string): Promise<void> {
  const landedInIdb = await writeValueToIdb(key, value);
  if (!landedInIdb) {
    await writeValue(key, value);
    return;
  }
  try {
    localStorage.removeItem(key);
    localStorage.removeItem(legacyKey);
  } catch {
    /* plaintext copy is unreachable — the encrypted copy is already stored */
  }
}

async function encryptAuthConfig(
  config: AuthConfig,
  passphrase: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: Record<string, any> = { ...config };
  for (const key of AUTH_CONFIG_SENSITIVE_KEYS) {
    const val = config[key];
    if (typeof val === "string" && val.trim() !== "") {
      result[key] = await encryptString(val, passphrase);
    }
  }
  return result;
}

async function decryptAuthConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>,
  passphrase: string
): Promise<AuthConfig> {
  const result = { ...config } as AuthConfig;
  for (const key of AUTH_CONFIG_SENSITIVE_KEYS) {
    result[key] = await decryptString(config[key], passphrase) as never;
  }
  return result;
}

async function encryptKeyValueFields(
  fields: KeyValueField[],
  passphrase: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  return Promise.all(
    fields.map(async (field) => ({
      ...field,
      value: await encryptString(field.value, passphrase),
    }))
  );
}

async function decryptKeyValueFields(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any[],
  passphrase: string
): Promise<KeyValueField[]> {
  return Promise.all(
    fields.map(async (field) => ({
      ...field,
      value: await decryptString(field.value, passphrase),
    }))
  );
}

// ── Storage Keys ─────────────────────────────────────────────

export const STORAGE_KEYS = {
  TABS: "intab_api_tabs",
  HISTORY: "intab_api_history",
  COLLECTIONS: "intab_api_collections",
  ENV_VARS: "intab_api_env_vars",
  ENVIRONMENTS: "intab_api_environments",
  ACTIVE_ENV: "intab_api_active_env",
  CUSTOM_PRESETS: "intab_api_custom_presets",
  ADDED_PRESET_IDS: "intab_api_added_preset_ids",
  CUSTOM_PROXY: "intab_api_custom_proxy",
} as const;

export const LEGACY_STORAGE_KEYS = {
  TABS: "devutils_api_tabs",
  HISTORY: "devutils_api_history",
  COLLECTIONS: "devutils_api_collections",
  ENV_VARS: "devutils_api_env_vars",
  ENVIRONMENTS: "devutils_api_environments",
  ACTIVE_ENV: "devutils_api_active_env",
  CUSTOM_PRESETS: "devutils_api_custom_presets",
  ADDED_PRESET_IDS: "devutils_api_added_preset_ids",
  CUSTOM_PROXY: "devutils_api_custom_proxy",
} as const;

function getStoredItem(key: string, legacyKey: string): string | null {
  try {
    const val = localStorage.getItem(key);
    if (val !== null) return val;
    return localStorage.getItem(legacyKey);
  } catch {
    return null;
  }
}

/** readValue-based twin of getStoredItem for keys that moved to IDB. */
async function getStoredItemAsync(key: string, legacyKey: string): Promise<string | null> {
  const val = await readValue(key);
  if (val !== null) return val;
  return readValue(legacyKey);
}

// ── LocalStorageAdapter (original, kept as fallback) ────────

export class LocalStorageAdapter implements StorageAdapter {
  async getTabs(): Promise<{ tabs: TabState[]; activeTabId: string } | null> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.TABS, LEGACY_STORAGE_KEYS.TABS);
      if (!saved) return null;
      const parsed = JSON.parse(saved) as { tabs: TabState[]; activeTabId: string };
      if (!parsed.tabs || parsed.tabs.length === 0) return null;
      parsed.tabs = parsed.tabs.map(t => ({ ...t, loading: false, error: null }));
      return parsed;
    } catch {
      return null;
    }
  }

  async saveTabs(tabs: TabState[], activeTabId: string): Promise<void> {
    try {
      const serializable = tabs.map(t => ({ ...t, loading: false, error: null, response: null }));
      localStorage.setItem(STORAGE_KEYS.TABS, JSON.stringify({ tabs: serializable, activeTabId }));
    } catch (e) {
      console.error("Failed to save tabs", e);
    }
  }

  async getHistory(): Promise<HistoryItem[]> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.HISTORY, LEGACY_STORAGE_KEYS.HISTORY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveHistory(history: HistoryItem[]): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    } catch (e) {
      console.error("Failed to save history", e);
    }
  }

  async getCollections(): Promise<ImportedCollection[]> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.COLLECTIONS, LEGACY_STORAGE_KEYS.COLLECTIONS);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveCollections(collections: ImportedCollection[]): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.COLLECTIONS, JSON.stringify(collections));
    } catch (e) {
      console.error("Failed to save collections", e);
    }
  }

  async getEnvVars(): Promise<KeyValueField[]> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.ENV_VARS, LEGACY_STORAGE_KEYS.ENV_VARS);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveEnvVars(vars: KeyValueField[]): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.ENV_VARS, JSON.stringify(vars));
    } catch (e) {
      console.error("Failed to save env vars", e);
    }
  }

  async getEnvironments(): Promise<Environment[]> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.ENVIRONMENTS, LEGACY_STORAGE_KEYS.ENVIRONMENTS);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveEnvironments(envs: Environment[]): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.ENVIRONMENTS, JSON.stringify(envs));
    } catch (e) {
      console.error("Failed to save environments", e);
    }
  }

  async getActiveEnvId(): Promise<string | null> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.ACTIVE_ENV, LEGACY_STORAGE_KEYS.ACTIVE_ENV);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }

  async saveActiveEnvId(id: string | null): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_ENV, JSON.stringify(id));
    } catch (e) {
      console.error("Failed to save active env id", e);
    }
  }

  async getCustomPresets(): Promise<LibraryPreset[]> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.CUSTOM_PRESETS, LEGACY_STORAGE_KEYS.CUSTOM_PRESETS);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveCustomPresets(presets: LibraryPreset[]): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(presets));
    } catch (e) {
      console.error("Failed to save custom presets", e);
    }
  }

  async getAddedPresetIds(): Promise<string[]> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.ADDED_PRESET_IDS, LEGACY_STORAGE_KEYS.ADDED_PRESET_IDS);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveAddedPresetIds(ids: string[]): Promise<void> {
    try {
      localStorage.setItem(STORAGE_KEYS.ADDED_PRESET_IDS, JSON.stringify(ids));
    } catch (e) {
      console.error("Failed to save added preset ids", e);
    }
  }

  async getCustomProxyUrl(): Promise<string | null> {
    try {
      const saved = getStoredItem(STORAGE_KEYS.CUSTOM_PROXY, LEGACY_STORAGE_KEYS.CUSTOM_PROXY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }

  async saveCustomProxyUrl(url: string | null): Promise<void> {
    try {
      if (url && url.trim()) {
        localStorage.setItem(STORAGE_KEYS.CUSTOM_PROXY, JSON.stringify(url.trim()));
      } else {
        localStorage.removeItem(STORAGE_KEYS.CUSTOM_PROXY);
        localStorage.removeItem(LEGACY_STORAGE_KEYS.CUSTOM_PROXY);
      }
    } catch (e) {
      console.error("Failed to save custom proxy url", e);
    }
  }
}

// ── EncryptedStorageAdapter ─────────────────────────────────
// Drop-in replacement that encrypts sensitive fields at rest.
// Non-sensitive fields (method, URL, tab names, etc.) remain
// plaintext for searchability and performance.

export class EncryptedStorageAdapter implements StorageAdapter {
  private fallback = new LocalStorageAdapter();

  private async getKey(): Promise<string | null> {
    return getPassphrase();
  }

  // ── Tabs ────────────────────────────────────────────────
  // Encrypts: authConfig fields on each tab

  async getTabs(): Promise<{ tabs: TabState[]; activeTabId: string } | null> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.getTabs();

    try {
      const saved = await getStoredItemAsync(STORAGE_KEYS.TABS, LEGACY_STORAGE_KEYS.TABS);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      if (!parsed.tabs || parsed.tabs.length === 0) return null;

      parsed.tabs = await Promise.all(
        parsed.tabs.map(async (t: TabState & { authConfig: Record<string, unknown> }) => ({
          ...t,
          loading: false,
          error: null,
          authConfig: t.authConfig
            ? await decryptAuthConfig(t.authConfig as Record<string, unknown>, passphrase)
            : t.authConfig,
          // Decrypt header values (may contain tokens)
          headers: t.headers
            ? await decryptKeyValueFields(t.headers, passphrase)
            : t.headers,
        }))
      );
      return parsed;
    } catch {
      return null;
    }
  }

  async saveTabs(tabs: TabState[], activeTabId: string): Promise<void> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.saveTabs(tabs, activeTabId);

    try {
      const encrypted = await Promise.all(
        tabs.map(async (t) => ({
          ...t,
          loading: false,
          error: null,
          response: null,
          authConfig: await encryptAuthConfig(t.authConfig, passphrase),
          headers: await encryptKeyValueFields(
            t.headers.filter(h => h.key.trim() !== "" || h.value.trim() !== ""),
            passphrase
          ),
        }))
      );
      await writePreservingSecrets(STORAGE_KEYS.TABS, LEGACY_STORAGE_KEYS.TABS, { tabs: encrypted, activeTabId });
    } catch (e) {
      console.error("Failed to save encrypted tabs", e);
    }
  }

  // ── History ─────────────────────────────────────────────
  // Security: Strip auth & redact sensitive parameters/headers from history.
  // History records *what* was called, not *with which credentials*.
  // Request bodies / form params CAN still carry secrets (tokens in JSON),
  // so they are encrypted at rest and decrypted transparently on read.

  async getHistory(): Promise<HistoryItem[]> {
    let items: HistoryItem[];
    try {
      const saved = await getStoredItemAsync(STORAGE_KEYS.HISTORY, LEGACY_STORAGE_KEYS.HISTORY);
      items = saved ? (JSON.parse(saved) as HistoryItem[]) : [];
    } catch {
      items = [];
    }
    const passphrase = await this.getKey();
    if (!passphrase) return items;

    try {
      return await Promise.all(
        items.map(async (item) => {
          const decrypted: HistoryItem = { ...item };
          if (isCipherEnvelope(item.bodyValue)) {
            try {
              decrypted.bodyValue = await decrypt(item.bodyValue, passphrase);
            } catch {
              noteUnreadableEnvelope(item.bodyValue);
              decrypted.bodyValue = "";
            }
          }
          if (Array.isArray(item.formParams)) {
            decrypted.formParams = await Promise.all(
              item.formParams.map(async (f) => {
                if (isCipherEnvelope(f.value)) {
                  try {
                    return { ...f, value: await decrypt(f.value, passphrase) };
                  } catch {
                    noteUnreadableEnvelope(f.value);
                    return { ...f, value: "" };
                  }
                }
                return f;
              })
            );
          }
          return decrypted;
        })
      );
    } catch {
      return items;
    }
  }

  async saveHistory(history: HistoryItem[]): Promise<void> {
    const passphrase = await this.getKey();
    const sensitiveParamRegex = /^(.*_)?(key|token|secret|password|passwd|auth|sig|signature|cred|credential|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|jwt)(_.*)?$/i;
    const sensitiveHeaderRegex = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|private-token|session-token|x-session-token|cookie|set-cookie|cf-access-client-secret|x-amz-security-token|x-csrf-token|x-xsrf-token)$/i;

    // Sanitize: remove auth credentials from history entries
    const sanitized = await Promise.all(history.map(async (item) => {
      let safeUrl = item.url;
      try {
        if (safeUrl && (safeUrl.startsWith("http://") || safeUrl.startsWith("https://"))) {
          const u = new URL(safeUrl);
          let modified = false;
          for (const [key] of Array.from(u.searchParams.entries())) {
            if (sensitiveParamRegex.test(key)) {
              u.searchParams.set(key, "••••••");
              modified = true;
            }
          }
          if (modified) safeUrl = u.toString();
        }
      } catch {
        // Leave URL as is if parsing fails
      }

      // Encrypt request body / form params at rest (they may embed secrets)
      let safeBodyValue: string | CipherEnvelope | undefined = item.bodyValue;
      if (passphrase && typeof safeBodyValue === "string" && safeBodyValue.trim() !== "") {
        safeBodyValue = await encrypt(safeBodyValue, passphrase);
      }
      let safeFormParams:
        | HistoryItem["formParams"]
        | Array<{ key: string; value: string | CipherEnvelope }>
        | undefined = item.formParams;
      if (passphrase && Array.isArray(safeFormParams)) {
        safeFormParams = await Promise.all(
          safeFormParams.map(async (f) => ({
            ...f,
            value:
              typeof f.value === "string" && f.value.trim() !== ""
                ? await encrypt(f.value, passphrase)
                : f.value,
          }))
        );
      }

      return {
        ...item,
        url: safeUrl,
        authConfig: undefined,
        authType: item.authType ? item.authType : undefined,
        bodyValue: safeBodyValue,
        formParams: safeFormParams,
        // Redact Authorization and token headers from history
        headers: item.headers?.map((h) => {
          if (sensitiveHeaderRegex.test(h.key.trim())) {
            return { ...h, value: "••••••" };
          }
          return h;
        }),
      };
    }));
    // Encrypted fields are CipherEnvelopes at rest; writeValue only
    // serializes, so the envelope-vs-string variance is erased on write.
    await writePreservingSecrets(STORAGE_KEYS.HISTORY, LEGACY_STORAGE_KEYS.HISTORY, sanitized);
  }

  // ── Collections ─────────────────────────────────────────
  // Encrypts: authConfig on each request in each collection

  async getCollections(): Promise<ImportedCollection[]> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.getCollections();

    try {
      const saved = await getStoredItemAsync(STORAGE_KEYS.COLLECTIONS, LEGACY_STORAGE_KEYS.COLLECTIONS);
      if (!saved) return [];
      const collections = JSON.parse(saved) as ImportedCollection[];

      // Await INSIDE the try so a single failed decrypt surfaces here
      // instead of escaping as an unhandled rejection.
      return await Promise.all(
        collections.map(async (col) => ({
          ...col,
          requests: await Promise.all(
            col.requests.map(async (req) => ({
              ...req,
              authConfig: req.authConfig
                ? await decryptAuthConfig(req.authConfig as unknown as Record<string, unknown>, passphrase)
                : req.authConfig,
            }))
          ),
        }))
      );
    } catch {
      return [];
    }
  }

  async saveCollections(collections: ImportedCollection[]): Promise<void> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.saveCollections(collections);

    try {
      const encrypted = await Promise.all(
        collections.map(async (col) => ({
          ...col,
          requests: await Promise.all(
            col.requests.map(async (req) => ({
              ...req,
              authConfig: await encryptAuthConfig(req.authConfig, passphrase),
            }))
          ),
        }))
      );
      await writePreservingSecrets(STORAGE_KEYS.COLLECTIONS, LEGACY_STORAGE_KEYS.COLLECTIONS, encrypted);
    } catch (e) {
      console.error("Failed to save encrypted collections", e);
    }
  }

  // ── Environment Variables (Global) ──────────────────────
  // Encrypts: value field of each key-value pair (keys remain plaintext)

  async getEnvVars(): Promise<KeyValueField[]> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.getEnvVars();

    try {
      const saved = await getStoredItemAsync(STORAGE_KEYS.ENV_VARS, LEGACY_STORAGE_KEYS.ENV_VARS);
      if (!saved) return [];
      const fields = JSON.parse(saved);
      // Await INSIDE the try so decrypt failures surface here instead of
      // escaping as an unhandled rejection.
      return await decryptKeyValueFields(fields, passphrase);
    } catch {
      return [];
    }
  }

  async saveEnvVars(vars: KeyValueField[]): Promise<void> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.saveEnvVars(vars);

    try {
      const encrypted = await encryptKeyValueFields(vars, passphrase);
      await writePreservingSecrets(STORAGE_KEYS.ENV_VARS, LEGACY_STORAGE_KEYS.ENV_VARS, encrypted);
    } catch (e) {
      console.error("Failed to save encrypted env vars", e);
    }
  }

  // ── Environments ────────────────────────────────────────
  // Encrypts: variable values within each environment

  async getEnvironments(): Promise<Environment[]> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.getEnvironments();

    try {
      const saved = await getStoredItemAsync(STORAGE_KEYS.ENVIRONMENTS, LEGACY_STORAGE_KEYS.ENVIRONMENTS);
      if (!saved) return [];
      const envs = JSON.parse(saved) as Environment[];

      // Await INSIDE the try so a single failed decrypt surfaces here
      // instead of escaping as an unhandled rejection.
      return await Promise.all(
        envs.map(async (env) => ({
          ...env,
          variables: await decryptKeyValueFields(env.variables, passphrase),
        }))
      );
    } catch {
      return [];
    }
  }

  async saveEnvironments(envs: Environment[]): Promise<void> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.saveEnvironments(envs);

    try {
      const encrypted = await Promise.all(
        envs.map(async (env) => ({
          ...env,
          variables: await encryptKeyValueFields(env.variables, passphrase),
        }))
      );
      await writePreservingSecrets(STORAGE_KEYS.ENVIRONMENTS, LEGACY_STORAGE_KEYS.ENVIRONMENTS, encrypted);
    } catch (e) {
      console.error("Failed to save encrypted environments", e);
    }
  }

  // ── Active Env ID ───────────────────────────────────────
  // Not sensitive — pass through to fallback

  async getActiveEnvId(): Promise<string | null> {
    return this.fallback.getActiveEnvId();
  }

  async saveActiveEnvId(id: string | null): Promise<void> {
    return this.fallback.saveActiveEnvId(id);
  }

  // ── Custom Presets ──────────────────────────────────────
  // Encrypts: authConfig fields on presets

  async getCustomPresets(): Promise<LibraryPreset[]> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.getCustomPresets();

    try {
      const saved = await getStoredItemAsync(STORAGE_KEYS.CUSTOM_PRESETS, LEGACY_STORAGE_KEYS.CUSTOM_PRESETS);
      if (!saved) return [];
      const presets = JSON.parse(saved) as LibraryPreset[];

      // Await INSIDE the try so a single failed decrypt surfaces here
      // instead of escaping as an unhandled rejection.
      return await Promise.all(
        presets.map(async (preset) => {
          if (preset.authConfig) {
            return {
              ...preset,
              authConfig: await decryptAuthConfig(
                preset.authConfig as unknown as Record<string, unknown>,
                passphrase
              ),
            };
          }
          return preset;
        })
      );
    } catch {
      return [];
    }
  }

  async saveCustomPresets(presets: LibraryPreset[]): Promise<void> {
    const passphrase = await this.getKey();
    if (!passphrase) return this.fallback.saveCustomPresets(presets);

    try {
      const encrypted = await Promise.all(
        presets.map(async (preset) => {
          if (preset.authConfig) {
            return {
              ...preset,
              authConfig: await encryptAuthConfig(
                preset.authConfig as unknown as AuthConfig,
                passphrase
              ),
            };
          }
          return preset;
        })
      );
      await writePreservingSecrets(STORAGE_KEYS.CUSTOM_PRESETS, LEGACY_STORAGE_KEYS.CUSTOM_PRESETS, encrypted);
    } catch (e) {
      console.error("Failed to save encrypted custom presets", e);
    }
  }

  async getAddedPresetIds(): Promise<string[]> {
    return this.fallback.getAddedPresetIds();
  }

  async saveAddedPresetIds(ids: string[]): Promise<void> {
    return this.fallback.saveAddedPresetIds(ids);
  }

  async getCustomProxyUrl(): Promise<string | null> {
    return this.fallback.getCustomProxyUrl();
  }

  async saveCustomProxyUrl(url: string | null): Promise<void> {
    return this.fallback.saveCustomProxyUrl(url);
  }
}

// ── Auto-Migration ───────────────────────────────────────────
/**
 * Automatically migrate existing plaintext localStorage data to encrypted format.
 * Idempotent: safely skips any field that is already a CipherEnvelope.
 */
export async function migratePlaintextStorage(passphrase: string): Promise<string[]> {
  const migratedKeys: string[] = [];

  // 1. intab_api_tabs
  try {
    const rawTabs = await getStoredItemAsync(STORAGE_KEYS.TABS, LEGACY_STORAGE_KEYS.TABS);
    if (rawTabs) {
      const parsed = JSON.parse(rawTabs);
      if (parsed && Array.isArray(parsed.tabs)) {
        let changed = false;
         
        const migratedTabs = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.tabs.map(async (t: any) => {
            let tabChanged = false;
            let newAuthConfig = t.authConfig;
            if (t.authConfig) {
              const encAuth = { ...t.authConfig };
              for (const key of AUTH_CONFIG_SENSITIVE_KEYS) {
                const val = t.authConfig[key];
                if (typeof val === "string" && val.trim() !== "" && !isCipherEnvelope(val)) {
                  encAuth[key] = await encrypt(val, passphrase);
                  tabChanged = true;
                }
              }
              newAuthConfig = encAuth;
            }

            let newHeaders = t.headers;
            if (Array.isArray(t.headers)) {
               
              const encHeaders = await Promise.all(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                t.headers.map(async (h: any) => {
                  if (typeof h.value === "string" && h.value.trim() !== "" && !isCipherEnvelope(h.value)) {
                    tabChanged = true;
                    return { ...h, value: await encrypt(h.value, passphrase) };
                  }
                  return h;
                })
              );
              newHeaders = encHeaders;
            }

            if (tabChanged) changed = true;
            return { ...t, authConfig: newAuthConfig, headers: newHeaders };
          })
        );
        if (changed) {
          await persistMigrated(
            STORAGE_KEYS.TABS,
            LEGACY_STORAGE_KEYS.TABS,
            JSON.stringify({ ...parsed, tabs: migratedTabs })
          );
          migratedKeys.push(STORAGE_KEYS.TABS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_tabs:", e);
  }

  // 2. intab_api_history (strip authConfig & sanitize sensitive headers)
  try {
    const rawHist = await getStoredItemAsync(STORAGE_KEYS.HISTORY, LEGACY_STORAGE_KEYS.HISTORY);
    if (rawHist) {
      const parsed = JSON.parse(rawHist);
      if (Array.isArray(parsed)) {
        let changed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sanitized = parsed.map((item: any) => {
          if (item.authConfig) changed = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const headers = item.headers?.map((h: any) => {
            const lower = (h.key || "").toLowerCase().trim();
            if (
              (lower === "authorization" || lower === "x-api-key" || lower === "proxy-authorization") &&
              h.value !== "••••••"
            ) {
              changed = true;
              return { ...h, value: "••••••" };
            }
            return h;
          });
          return {
            ...item,
            authConfig: undefined,
            headers,
          };
        });
        if (changed) {
          await persistMigrated(
            STORAGE_KEYS.HISTORY,
            LEGACY_STORAGE_KEYS.HISTORY,
            JSON.stringify(sanitized)
          );
          migratedKeys.push(STORAGE_KEYS.HISTORY);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_history:", e);
  }

  // 3. intab_api_env_vars
  try {
    const rawVars = await getStoredItemAsync(STORAGE_KEYS.ENV_VARS, LEGACY_STORAGE_KEYS.ENV_VARS);
    if (rawVars) {
      const parsed = JSON.parse(rawVars);
      if (Array.isArray(parsed)) {
        let changed = false;
         
        const encVars = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.map(async (v: any) => {
            if (typeof v.value === "string" && v.value.trim() !== "" && !isCipherEnvelope(v.value)) {
              changed = true;
              return { ...v, value: await encrypt(v.value, passphrase) };
            }
            return v;
          })
        );
        if (changed) {
          await persistMigrated(
            STORAGE_KEYS.ENV_VARS,
            LEGACY_STORAGE_KEYS.ENV_VARS,
            JSON.stringify(encVars)
          );
          migratedKeys.push(STORAGE_KEYS.ENV_VARS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_env_vars:", e);
  }

  // 4. intab_api_environments
  try {
    const rawEnvs = await getStoredItemAsync(STORAGE_KEYS.ENVIRONMENTS, LEGACY_STORAGE_KEYS.ENVIRONMENTS);
    if (rawEnvs) {
      const parsed = JSON.parse(rawEnvs);
      if (Array.isArray(parsed)) {
        let changed = false;
         
        const encEnvs = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.map(async (env: any) => {
            let envChanged = false;
            let newVars = env.variables;
            if (Array.isArray(env.variables)) {
               
              newVars = await Promise.all(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                env.variables.map(async (v: any) => {
                  if (typeof v.value === "string" && v.value.trim() !== "" && !isCipherEnvelope(v.value)) {
                    envChanged = true;
                    return { ...v, value: await encrypt(v.value, passphrase) };
                  }
                  return v;
                })
              );
            }
            if (envChanged) changed = true;
            return { ...env, variables: newVars };
          })
        );
        if (changed) {
          await persistMigrated(
            STORAGE_KEYS.ENVIRONMENTS,
            LEGACY_STORAGE_KEYS.ENVIRONMENTS,
            JSON.stringify(encEnvs)
          );
          migratedKeys.push(STORAGE_KEYS.ENVIRONMENTS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_environments:", e);
  }

  // 5. intab_api_collections
  try {
    const rawCols = await getStoredItemAsync(STORAGE_KEYS.COLLECTIONS, LEGACY_STORAGE_KEYS.COLLECTIONS);
    if (rawCols) {
      const parsed = JSON.parse(rawCols);
      if (Array.isArray(parsed)) {
        let changed = false;
         
        const encCols = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.map(async (col: any) => {
            let colChanged = false;
            let newRequests = col.requests;
            if (Array.isArray(col.requests)) {
               
              newRequests = await Promise.all(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                col.requests.map(async (req: any) => {
                  if (req.authConfig) {
                    let reqChanged = false;
                    const encAuth = { ...req.authConfig };
                    for (const key of AUTH_CONFIG_SENSITIVE_KEYS) {
                      const val = req.authConfig[key];
                      if (typeof val === "string" && val.trim() !== "" && !isCipherEnvelope(val)) {
                        encAuth[key] = await encrypt(val, passphrase);
                        reqChanged = true;
                      }
                    }
                    if (reqChanged) {
                      colChanged = true;
                      return { ...req, authConfig: encAuth };
                    }
                  }
                  return req;
                })
              );
            }
            if (colChanged) changed = true;
            return { ...col, requests: newRequests };
          })
        );
        if (changed) {
          await persistMigrated(
            STORAGE_KEYS.COLLECTIONS,
            LEGACY_STORAGE_KEYS.COLLECTIONS,
            JSON.stringify(encCols)
          );
          migratedKeys.push(STORAGE_KEYS.COLLECTIONS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_collections:", e);
  }

  // 6. intab_api_custom_presets
  try {
    const rawPresets = await getStoredItemAsync(STORAGE_KEYS.CUSTOM_PRESETS, LEGACY_STORAGE_KEYS.CUSTOM_PRESETS);
    if (rawPresets) {
      const parsed = JSON.parse(rawPresets);
      if (Array.isArray(parsed)) {
        let changed = false;
         
        const encPresets = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.map(async (preset: any) => {
            if (preset.authConfig) {
              let presetChanged = false;
              const encAuth = { ...preset.authConfig };
              for (const key of AUTH_CONFIG_SENSITIVE_KEYS) {
                const val = preset.authConfig[key];
                if (typeof val === "string" && val.trim() !== "" && !isCipherEnvelope(val)) {
                  encAuth[key] = await encrypt(val, passphrase);
                  presetChanged = true;
                }
              }
              if (presetChanged) {
                changed = true;
                return { ...preset, authConfig: encAuth };
              }
            }
            return preset;
          })
        );
        if (changed) {
          await persistMigrated(
            STORAGE_KEYS.CUSTOM_PRESETS,
            LEGACY_STORAGE_KEYS.CUSTOM_PRESETS,
            JSON.stringify(encPresets)
          );
          migratedKeys.push(STORAGE_KEYS.CUSTOM_PRESETS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_custom_presets:", e);
  }

  return migratedKeys;
}

export const apiStorage: StorageAdapter = new EncryptedStorageAdapter();

// Automatically encrypt any existing plaintext data in the background
if (typeof window !== "undefined") {
  setTimeout(() => {
    void getPassphrase().then((key) => {
      if (key) {
        migratePlaintextStorage(key).catch((err) => {
          console.warn("Background migration notice:", err);
        });
      }
    });
  }, 100);
}


