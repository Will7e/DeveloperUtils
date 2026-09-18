import { TabState, HistoryItem, ImportedCollection, Environment, KeyValueField, AuthConfig } from "./api-tester.store";
import type { LibraryPreset } from "@/features/api-tester/data/preset-library.data";
import { encrypt, decrypt, isCipherEnvelope, type CipherEnvelope } from "@/services/crypto.service";
import { getPassphrase } from "@/services/vault.service";

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
      return ""; // Decryption failed — return empty
    }
  }
  return typeof value === "string" ? value : "";
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

  private getKey(): string | null {
    return getPassphrase();
  }

  // ── Tabs ────────────────────────────────────────────────
  // Encrypts: authConfig fields on each tab

  async getTabs(): Promise<{ tabs: TabState[]; activeTabId: string } | null> {
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.getTabs();

    try {
      const saved = getStoredItem(STORAGE_KEYS.TABS, LEGACY_STORAGE_KEYS.TABS);
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
    const passphrase = this.getKey();
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
      localStorage.setItem(STORAGE_KEYS.TABS, JSON.stringify({ tabs: encrypted, activeTabId }));
    } catch (e) {
      console.error("Failed to save encrypted tabs", e);
    }
  }

  // ── History ─────────────────────────────────────────────
  // Security: Strip auth from history entirely. History records
  // *what* was called, not *with which credentials*.

  async getHistory(): Promise<HistoryItem[]> {
    return this.fallback.getHistory();
  }

  async saveHistory(history: HistoryItem[]): Promise<void> {
    // Sanitize: remove auth credentials from history entries
    const sanitized = history.map((item) => ({
      ...item,
      authConfig: undefined,
      authType: item.authType ? item.authType : undefined,
      // Redact Authorization headers from history
      headers: item.headers?.map((h) => {
        const lowerKey = h.key.toLowerCase();
        if (lowerKey === "authorization" || lowerKey === "x-api-key" || lowerKey === "proxy-authorization") {
          return { ...h, value: "••••••" };
        }
        return h;
      }),
    }));
    return this.fallback.saveHistory(sanitized);
  }

  // ── Collections ─────────────────────────────────────────
  // Encrypts: authConfig on each request in each collection

  async getCollections(): Promise<ImportedCollection[]> {
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.getCollections();

    try {
      const saved = getStoredItem(STORAGE_KEYS.COLLECTIONS, LEGACY_STORAGE_KEYS.COLLECTIONS);
      if (!saved) return [];
      const collections = JSON.parse(saved) as ImportedCollection[];

      return Promise.all(
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
    const passphrase = this.getKey();
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
      localStorage.setItem(STORAGE_KEYS.COLLECTIONS, JSON.stringify(encrypted));
    } catch (e) {
      console.error("Failed to save encrypted collections", e);
    }
  }

  // ── Environment Variables (Global) ──────────────────────
  // Encrypts: value field of each key-value pair (keys remain plaintext)

  async getEnvVars(): Promise<KeyValueField[]> {
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.getEnvVars();

    try {
      const saved = getStoredItem(STORAGE_KEYS.ENV_VARS, LEGACY_STORAGE_KEYS.ENV_VARS);
      if (!saved) return [];
      const fields = JSON.parse(saved);
      return decryptKeyValueFields(fields, passphrase);
    } catch {
      return [];
    }
  }

  async saveEnvVars(vars: KeyValueField[]): Promise<void> {
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.saveEnvVars(vars);

    try {
      const encrypted = await encryptKeyValueFields(vars, passphrase);
      localStorage.setItem(STORAGE_KEYS.ENV_VARS, JSON.stringify(encrypted));
    } catch (e) {
      console.error("Failed to save encrypted env vars", e);
    }
  }

  // ── Environments ────────────────────────────────────────
  // Encrypts: variable values within each environment

  async getEnvironments(): Promise<Environment[]> {
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.getEnvironments();

    try {
      const saved = getStoredItem(STORAGE_KEYS.ENVIRONMENTS, LEGACY_STORAGE_KEYS.ENVIRONMENTS);
      if (!saved) return [];
      const envs = JSON.parse(saved) as Environment[];

      return Promise.all(
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
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.saveEnvironments(envs);

    try {
      const encrypted = await Promise.all(
        envs.map(async (env) => ({
          ...env,
          variables: await encryptKeyValueFields(env.variables, passphrase),
        }))
      );
      localStorage.setItem(STORAGE_KEYS.ENVIRONMENTS, JSON.stringify(encrypted));
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
    const passphrase = this.getKey();
    if (!passphrase) return this.fallback.getCustomPresets();

    try {
      const saved = getStoredItem(STORAGE_KEYS.CUSTOM_PRESETS, LEGACY_STORAGE_KEYS.CUSTOM_PRESETS);
      if (!saved) return [];
      const presets = JSON.parse(saved) as LibraryPreset[];

      return Promise.all(
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
    const passphrase = this.getKey();
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
      localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(encrypted));
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
    const rawTabs = localStorage.getItem(STORAGE_KEYS.TABS) || localStorage.getItem(LEGACY_STORAGE_KEYS.TABS);
    if (rawTabs) {
      const parsed = JSON.parse(rawTabs);
      if (parsed && Array.isArray(parsed.tabs)) {
        let changed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        if (changed || !localStorage.getItem(STORAGE_KEYS.TABS)) {
          localStorage.setItem(STORAGE_KEYS.TABS, JSON.stringify({ ...parsed, tabs: migratedTabs }));
          migratedKeys.push(STORAGE_KEYS.TABS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_tabs:", e);
  }

  // 2. intab_api_history (strip authConfig & sanitize sensitive headers)
  try {
    const rawHist = localStorage.getItem(STORAGE_KEYS.HISTORY) || localStorage.getItem(LEGACY_STORAGE_KEYS.HISTORY);
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
        if (changed || !localStorage.getItem(STORAGE_KEYS.HISTORY)) {
          localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(sanitized));
          migratedKeys.push(STORAGE_KEYS.HISTORY);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_history:", e);
  }

  // 3. intab_api_env_vars
  try {
    const rawVars = localStorage.getItem(STORAGE_KEYS.ENV_VARS) || localStorage.getItem(LEGACY_STORAGE_KEYS.ENV_VARS);
    if (rawVars) {
      const parsed = JSON.parse(rawVars);
      if (Array.isArray(parsed)) {
        let changed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        if (changed || !localStorage.getItem(STORAGE_KEYS.ENV_VARS)) {
          localStorage.setItem(STORAGE_KEYS.ENV_VARS, JSON.stringify(encVars));
          migratedKeys.push(STORAGE_KEYS.ENV_VARS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_env_vars:", e);
  }

  // 4. intab_api_environments
  try {
    const rawEnvs = localStorage.getItem(STORAGE_KEYS.ENVIRONMENTS) || localStorage.getItem(LEGACY_STORAGE_KEYS.ENVIRONMENTS);
    if (rawEnvs) {
      const parsed = JSON.parse(rawEnvs);
      if (Array.isArray(parsed)) {
        let changed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const encEnvs = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.map(async (env: any) => {
            let envChanged = false;
            let newVars = env.variables;
            if (Array.isArray(env.variables)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        if (changed || !localStorage.getItem(STORAGE_KEYS.ENVIRONMENTS)) {
          localStorage.setItem(STORAGE_KEYS.ENVIRONMENTS, JSON.stringify(encEnvs));
          migratedKeys.push(STORAGE_KEYS.ENVIRONMENTS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_environments:", e);
  }

  // 5. intab_api_collections
  try {
    const rawCols = localStorage.getItem(STORAGE_KEYS.COLLECTIONS) || localStorage.getItem(LEGACY_STORAGE_KEYS.COLLECTIONS);
    if (rawCols) {
      const parsed = JSON.parse(rawCols);
      if (Array.isArray(parsed)) {
        let changed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const encCols = await Promise.all(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parsed.map(async (col: any) => {
            let colChanged = false;
            let newRequests = col.requests;
            if (Array.isArray(col.requests)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        if (changed || !localStorage.getItem(STORAGE_KEYS.COLLECTIONS)) {
          localStorage.setItem(STORAGE_KEYS.COLLECTIONS, JSON.stringify(encCols));
          migratedKeys.push(STORAGE_KEYS.COLLECTIONS);
        }
      }
    }
  } catch (e) {
    console.warn("Auto-migration skipped for intab_api_collections:", e);
  }

  // 6. intab_api_custom_presets
  try {
    const rawPresets = localStorage.getItem(STORAGE_KEYS.CUSTOM_PRESETS) || localStorage.getItem(LEGACY_STORAGE_KEYS.CUSTOM_PRESETS);
    if (rawPresets) {
      const parsed = JSON.parse(rawPresets);
      if (Array.isArray(parsed)) {
        let changed = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        if (changed || !localStorage.getItem(STORAGE_KEYS.CUSTOM_PRESETS)) {
          localStorage.setItem(STORAGE_KEYS.CUSTOM_PRESETS, JSON.stringify(encPresets));
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
    const key = getPassphrase();
    if (key) {
      migratePlaintextStorage(key).catch((err) => {
        console.warn("Background migration notice:", err);
      });
    }
  }, 100);
}


