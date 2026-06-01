// ============================================================
// API Tester Store — State management for the REST Client
// ============================================================

import { create } from "zustand";
import JSZip from "jszip";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export type BodyType = "none" | "json" | "form-data" | "raw";
export type AuthType = "none" | "bearer" | "basic" | "api-key";

export interface KeyValueField {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface AuthConfig {
  bearerToken: string;
  basicUsername: string;
  basicPassword: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyPlacement: "header" | "query";
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  method: HttpMethod;
  url: string;
  status?: number;
  time?: number;
  error?: boolean;
  // Enriched fields for full replay
  headers?: Array<{ key: string; value: string }>;
  bodyType?: BodyType;
  bodyValue?: string;
  formParams?: Array<{ key: string; value: string }>;
  authType?: AuthType;
  authConfig?: AuthConfig;
}

export interface ImportedRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValueField[];
  headers: KeyValueField[];
  bodyType: BodyType;
  bodyValue: string;
  formParams: KeyValueField[];
  rawType: string;
  authType: AuthType;
  authConfig: AuthConfig;
}

export interface ImportedCollection {
  id: string;
  name: string;
  requests: ImportedRequest[];
}

export interface Environment {
  id: string;
  name: string;
  variables: KeyValueField[];
}

export interface ApiResponse {
  status: number;
  statusText: string;
  time: number; // in ms
  size: number; // in bytes
  headers: Record<string, string>;
  body: string;
}

export interface TabState {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValueField[];
  headers: KeyValueField[];
  bodyType: BodyType;
  bodyValue: string;
  formParams: KeyValueField[];
  rawType: string;
  authType: AuthType;
  authConfig: AuthConfig;
  response: ApiResponse | null;
  loading: boolean;
  error: string | null;
}

interface ApiTesterState {
  tabs: TabState[];
  activeTabId: string;
  history: HistoryItem[];
  collections: ImportedCollection[];
  envVars: KeyValueField[]; // Global variables
  environments: Environment[]; // Custom environments (Staging, Production, etc.)
  activeEnvironmentId: string | null; // active environment id, null means only Globals are used

  isInitialized: boolean;
  init: () => Promise<void>;

  // Tab management
  addTab: () => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  renameTab: (id: string, name: string) => void;

  // Active tab Setters
  setMethod: (method: HttpMethod) => void;
  setUrl: (url: string) => void;
  setBodyType: (type: BodyType) => void;
  setBodyValue: (value: string) => void;
  setRawType: (type: string) => void;
  setAuthType: (type: AuthType) => void;
  setAuthConfig: (config: Partial<AuthConfig>) => void;

  // Key-value editors for active tab
  addParam: () => void;
  updateParam: (id: string, updates: Partial<KeyValueField>) => void;
  removeParam: (id: string) => void;
  
  addHeader: () => void;
  updateHeader: (id: string, updates: Partial<KeyValueField>) => void;
  removeHeader: (id: string) => void;

  addFormParam: () => void;
  updateFormParam: (id: string, updates: Partial<KeyValueField>) => void;
  removeFormParam: (id: string) => void;

  // Sync utilities
  syncParamsFromUrl: (urlStr: string) => void;
  syncUrlFromParams: () => void;

  // Request trigger
  sendRequest: () => Promise<void>;
  
  // cURL generation
  generateCurl: () => string;

  // History & Presets
  loadHistoryItem: (item: HistoryItem) => void;
  clearHistory: () => void;
  loadPreset: (preset: {
    name?: string;
    method: HttpMethod;
    url: string;
    headers?: Array<{ key: string; value: string }>;
    params?: Array<{ key: string; value: string }>;
    bodyType?: BodyType;
    bodyValue?: string;
  }) => void;

  // Collections
  importCollection: (name: string, requests: ImportedRequest[]) => void;
  removeCollection: (id: string) => void;
  loadImportedRequest: (req: ImportedRequest) => void;

  // cURL & formatting
  formatActiveTabJsonBody: () => void;
  importFromCurl: (curlStr: string) => boolean;

  // Export functionality
  exportTabsAsZip: (tabIds: string[]) => Promise<void>;

  // Environment Variables
  setEnvVars: (vars: KeyValueField[]) => void;
  
  // Multi-Environment
  addEnvironment: (name: string) => string;
  updateEnvironment: (id: string, name: string) => void;
  removeEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string | null) => void;
  setEnvironmentVars: (id: string, vars: KeyValueField[]) => void;
}

// Generate unique ID
const genId = () => Math.random().toString(36).substring(2, 9);

// Initial empty rows
const createEmptyField = (): KeyValueField => ({
  id: genId(),
  key: "",
  value: "",
  enabled: true,
});

const defaultAuthConfig: AuthConfig = {
  bearerToken: "",
  basicUsername: "",
  basicPassword: "",
  apiKeyName: "",
  apiKeyValue: "",
  apiKeyPlacement: "header",
};

const createNewTab = (name: string): TabState => ({
  id: genId(),
  name,
  method: "GET",
  url: "https://jsonplaceholder.typicode.com/users",
  params: [createEmptyField()],
  headers: [
    { id: genId(), key: "Content-Type", value: "application/json", enabled: true },
    createEmptyField(),
  ],
  bodyType: "none",
  bodyValue: '{\n  "name": "John Doe",\n  "email": "john@example.com"\n}',
  formParams: [createEmptyField()],
  rawType: "text/plain",
  authType: "none",
  authConfig: { ...defaultAuthConfig },
  response: null,
  loading: false,
  error: null,
});

import { apiStorage } from "./api-tester.storage";

function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timeoutId: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}

const debouncedSaveTabs = debounce((tabs: TabState[], activeTabId: string) => {
  apiStorage.saveTabs(tabs, activeTabId);
}, 500);

// We keep these synchronous wrappers for the rest of the file to use,
// but they now forward to our async database adapter.
const saveStoredHistory = (history: HistoryItem[]) => {
  apiStorage.saveHistory(history);
};

const saveStoredCollections = (collections: ImportedCollection[]) => {
  apiStorage.saveCollections(collections);
};

const saveStoredEnvVars = (vars: KeyValueField[]) => {
  apiStorage.saveEnvVars(vars);
};

const saveStoredEnvironments = (envs: Environment[]) => {
  apiStorage.saveEnvironments(envs);
};

const saveStoredActiveEnvId = (id: string | null) => {
  apiStorage.saveActiveEnvId(id);
};

// Substitute environment variables in a string
export function substituteEnvVars(text: string, globalVars: KeyValueField[], activeEnvVars: KeyValueField[] = []): string {
  if (!text) return text;
  
  // Filter out disabled variables
  const globalEnabled = globalVars.filter(v => v.enabled && v.key.trim() !== "");
  const activeEnabled = activeEnvVars.filter(v => v.enabled && v.key.trim() !== "");
  
  // Combine variables: active environment overrides global
  const varMap = new Map<string, string>();
  
  // Add globals first
  globalEnabled.forEach(v => varMap.set(v.key, v.value));
  
  // Override with active environment
  activeEnabled.forEach(v => varMap.set(v.key, v.value));
  
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) => {
    const cleanKey = key.trim();
    return varMap.has(cleanKey) ? varMap.get(cleanKey)! : match;
  });
}

// Apply authentication to headers/url before sending
export function applyAuth(
  authType: AuthType,
  authConfig: AuthConfig,
  headers: Record<string, string>,
  url: string
): { headers: Record<string, string>; url: string } {
  const h = { ...headers };
  let u = url;

  if (authType === "bearer" && authConfig.bearerToken.trim()) {
    h["Authorization"] = `Bearer ${authConfig.bearerToken.trim()}`;
  } else if (authType === "basic" && authConfig.basicUsername.trim()) {
    // Robust Base64 UTF-8 safe encoding
    const encoded = btoa(unescape(encodeURIComponent(`${authConfig.basicUsername}:${authConfig.basicPassword}`)));
    h["Authorization"] = `Basic ${encoded}`;
  } else if (authType === "api-key" && authConfig.apiKeyName.trim() && authConfig.apiKeyValue.trim()) {
    if (authConfig.apiKeyPlacement === "header") {
      h[authConfig.apiKeyName.trim()] = authConfig.apiKeyValue.trim();
    } else {
      // Add to URL query params
      const sep = u.includes("?") ? "&" : "?";
      u += `${sep}${encodeURIComponent(authConfig.apiKeyName.trim())}=${encodeURIComponent(authConfig.apiKeyValue.trim())}`;
    }
  }

  return { headers: h, url: u };
}

export const useApiTesterStore = create<ApiTesterState>((set, get) => {
  const initialTab = createNewTab("Tab 1");

  // Helper: persist tabs after any mutation using our debounced storage adapter
  const persistTabs = () => {
    const { tabs, activeTabId } = get();
    debouncedSaveTabs(tabs, activeTabId);
  };

  return {
    isInitialized: false,
    tabs: [initialTab],
    activeTabId: initialTab.id,
    history: [],
    collections: [],
    envVars: [createEmptyField()],
    environments: [],
    activeEnvironmentId: null,

    init: async () => {
      if (get().isInitialized) return;
      const [storedTabs, history, collections, envVars, environments, activeEnvironmentId] = await Promise.all([
        apiStorage.getTabs(),
        apiStorage.getHistory(),
        apiStorage.getCollections(),
        apiStorage.getEnvVars(),
        apiStorage.getEnvironments(),
        apiStorage.getActiveEnvId()
      ]);
      set({
        isInitialized: true,
        tabs: storedTabs ? storedTabs.tabs : [initialTab],
        activeTabId: storedTabs ? storedTabs.activeTabId : initialTab.id,
        history,
        collections,
        envVars: envVars.length > 0 ? envVars : [createEmptyField()],
        environments,
        activeEnvironmentId
      });
    },

    // Tab management
    addTab: () => {
      set((state) => {
        // Find next available tab number to avoid duplicates
        const existingNums = state.tabs
          .map(t => { const m = t.name.match(/^Tab (\d+)$/); return m && m[1] ? parseInt(m[1], 10) : 0; })
          .filter(n => n > 0);
        const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : state.tabs.length + 1;
        const newTab = createNewTab(`Tab ${nextNum}`);
        return {
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
        };
      });
      persistTabs();
    },
    removeTab: (id) => {
      set((state) => {
        if (state.tabs.length === 1) return state; // Don't remove the last tab
        const newTabs = state.tabs.filter((t) => t.id !== id);
        return {
          tabs: newTabs,
          activeTabId: state.activeTabId === id ? (newTabs[newTabs.length - 1]?.id || "") : state.activeTabId,
        };
      });
      persistTabs();
    },
    setActiveTab: (id) => {
      set({ activeTabId: id });
      persistTabs();
    },
    renameTab: (id, name) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === id ? { ...t, name } : t)),
      }));
      persistTabs();
    },

    setMethod: (method) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, method } : t)),
      }));
      persistTabs();
    },
    
    setUrl: (url) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, url } : t)),
      }));
      get().syncParamsFromUrl(url);
      persistTabs();
    },

    setBodyType: (bodyType) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, bodyType } : t)),
      }));
      persistTabs();
    },
    setBodyValue: (bodyValue) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, bodyValue } : t)),
      }));
      persistTabs();
    },
    setRawType: (rawType) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, rawType } : t)),
      }));
      persistTabs();
    },
    setAuthType: (authType) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, authType } : t)),
      }));
      persistTabs();
    },
    setAuthConfig: (config) => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, authConfig: { ...t.authConfig, ...config } } : t)),
      }));
      persistTabs();
    },

    // Params actions
    addParam: () => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, params: [...t.params, createEmptyField()] } : t)),
      }));
      persistTabs();
    },
    updateParam: (id, updates) => {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === state.activeTabId
            ? { ...t, params: t.params.map((p) => (p.id === id ? { ...p, ...updates } : p)) }
            : t
        ),
      }));
      get().syncUrlFromParams();
      persistTabs();
    },
    removeParam: (id) => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id === state.activeTabId) {
            const filtered = t.params.filter((p) => p.id !== id);
            return { ...t, params: filtered.length === 0 ? [createEmptyField()] : filtered };
          }
          return t;
        }),
      }));
      get().syncUrlFromParams();
      persistTabs();
    },

    // Headers actions
    addHeader: () => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, headers: [...t.headers, createEmptyField()] } : t)),
      }));
      persistTabs();
    },
    updateHeader: (id, updates) => {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === state.activeTabId
            ? { ...t, headers: t.headers.map((h) => (h.id === id ? { ...h, ...updates } : h)) }
            : t
        ),
      }));
      persistTabs();
    },
    removeHeader: (id) => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id === state.activeTabId) {
            const filtered = t.headers.filter((h) => h.id !== id);
            return { ...t, headers: filtered.length === 0 ? [createEmptyField()] : filtered };
          }
          return t;
        }),
      }));
      persistTabs();
    },

    // Form Data actions
    addFormParam: () => {
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, formParams: [...t.formParams, createEmptyField()] } : t)),
      }));
      persistTabs();
    },
    updateFormParam: (id, updates) => {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === state.activeTabId
            ? { ...t, formParams: t.formParams.map((f) => (f.id === id ? { ...f, ...updates } : f)) }
            : t
        ),
      }));
      persistTabs();
    },
    removeFormParam: (id) => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id === state.activeTabId) {
            const filtered = t.formParams.filter((f) => f.id !== id);
            return { ...t, formParams: filtered.length === 0 ? [createEmptyField()] : filtered };
          }
          return t;
        }),
      }));
      persistTabs();
    },

    // Sync logic: URL -> Params with high-efficiency stable diff checking
    syncParamsFromUrl: (urlStr) => {
      try {
        const activeTab = get().tabs.find((t) => t.id === get().activeTabId);
        if (!activeTab) return;

        if (!urlStr || !urlStr.includes("?")) {
          // If already clean empty parameters, skip update to prevent ID jitter
          const firstParam = activeTab.params[0];
          if (activeTab.params.length === 1 && firstParam !== undefined && firstParam.key === "" && firstParam.value === "") {
            return;
          }
          set((state) => ({
            tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, params: [createEmptyField()] } : t)),
          }));
          return;
        }
        const queryString = urlStr.substring(urlStr.indexOf("?") + 1);
        const searchParams = new URLSearchParams(queryString);
        
        const parsed: Array<{ key: string; value: string }> = [];
        searchParams.forEach((value, key) => {
          parsed.push({ key, value });
        });

        // Filter current active/enabled params (excluding the blank trailing row)
        const currentActive = activeTab.params.filter((p) => p.key !== "" || p.value !== "");

        const isSame = parsed.length === currentActive.length &&
          parsed.every((p, idx) => {
            const cur = currentActive[idx];
            return cur !== undefined && cur.key === p.key && cur.value === p.value;
          });

        if (isSame) {
          // No parameters changed: maintain stable elements & keys!
          return;
        }

        const newParams: KeyValueField[] = parsed.map((p) => ({
          id: genId(),
          key: p.key,
          value: p.value,
          enabled: true,
        }));

        newParams.push(createEmptyField()); // Extra empty row at end
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, params: newParams } : t)),
        }));
      } catch {
        // Invalid URL or error parsing search string, fail silently
      }
    },

    // Sync logic: Params -> URL
    syncUrlFromParams: () => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return;
      const { url, params } = tab;
      
      try {
        let baseUrl = url;
        if (url.includes("?")) {
          baseUrl = url.substring(0, url.indexOf("?"));
        }

        const activeParams = params.filter((p) => p.enabled && p.key.trim() !== "");
        if (activeParams.length === 0) {
          set((state) => ({
            tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, url: baseUrl } : t)),
          }));
          return;
        }

        const searchParams = new URLSearchParams();
        activeParams.forEach((p) => {
          searchParams.append(p.key.trim(), p.value);
        });

        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, url: `${baseUrl}?${searchParams.toString()}` } : t)),
        }));
      } catch {
        // Fail silently
      }
    },

    // Generate cURL command from current state
    generateCurl: () => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return "";
      const { method, url, headers, bodyType, bodyValue, formParams, rawType, authType, authConfig } = tab;

      const activeEnvVars = state.activeEnvironmentId ? state.environments.find(e => e.id === state.activeEnvironmentId)?.variables || [] : [];

      let computedHeaders: Record<string, string> = {};
      headers.forEach((h) => {
        if (h.enabled && h.key.trim() !== "") {
          computedHeaders[h.key.trim()] = substituteEnvVars(h.value.trim(), state.envVars, activeEnvVars);
        }
      });

      const substitutedUrl = substituteEnvVars(url, state.envVars, activeEnvVars);
      const substitutedAuthConfig = {
        bearerToken: substituteEnvVars(authConfig.bearerToken, state.envVars, activeEnvVars),
        basicUsername: substituteEnvVars(authConfig.basicUsername, state.envVars, activeEnvVars),
        basicPassword: substituteEnvVars(authConfig.basicPassword, state.envVars, activeEnvVars),
        apiKeyName: substituteEnvVars(authConfig.apiKeyName, state.envVars, activeEnvVars),
        apiKeyValue: substituteEnvVars(authConfig.apiKeyValue, state.envVars, activeEnvVars),
        apiKeyPlacement: authConfig.apiKeyPlacement,
      };

      // Apply auth
      const authed = applyAuth(authType, substitutedAuthConfig, computedHeaders, substitutedUrl);
      computedHeaders = authed.headers;
      const finalUrl = authed.url;

      // Ensure Content-Type is correct before adding to parts
      if (method !== "GET" && method !== "HEAD") {
        const hasContentType = Object.keys(computedHeaders).some(k => k.toLowerCase() === 'content-type');
        if (bodyType === "json" && !hasContentType) {
          computedHeaders["Content-Type"] = "application/json";
        } else if (bodyType === "raw" && !hasContentType) {
          computedHeaders["Content-Type"] = rawType;
        }
      }

      let parts: string[] = [`curl -X ${method}`];

      // Headers
      Object.entries(computedHeaders).forEach(([k, v]) => {
        // POSIX shell compliant single quote escaping
        parts.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
      });

      // Body
      if (method !== "GET" && method !== "HEAD") {
        const activeEnvVars = state.activeEnvironmentId ? state.environments.find(e => e.id === state.activeEnvironmentId)?.variables || [] : [];
        const subBody = substituteEnvVars(bodyValue, state.envVars, activeEnvVars);
        if (bodyType === "json" && subBody.trim()) {
          parts.push(`  -d '${subBody.replace(/'/g, "'\\''")}'`);
        } else if (bodyType === "raw" && subBody.trim()) {
          parts.push(`  -d '${subBody.replace(/'/g, "'\\''")}'`);
        } else if (bodyType === "form-data") {
          formParams.forEach((f) => {
            if (f.enabled && f.key.trim()) {
              const activeEnvVars = state.activeEnvironmentId ? state.environments.find(e => e.id === state.activeEnvironmentId)?.variables || [] : [];
              const subVal = substituteEnvVars(f.value, state.envVars, activeEnvVars);
              parts.push(`  -F '${f.key.trim()}=${subVal.replace(/'/g, "'\\''")}'`);
            }
          });
        }
      }

      parts.push(`  '${finalUrl.replace(/'/g, "'\\''")}'`);
      return parts.join(" \\\n");
    },

    // Send request using standard window.fetch
    sendRequest: async () => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (!tab) return;
      const { method, url, params, headers, bodyType, bodyValue, formParams, rawType, authType, authConfig } = tab;
      
      set((state) => ({
        tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, loading: true, error: null, response: null } : t)),
      }));

      const startTime = performance.now();
      let computedHeaders: Record<string, string> = {};

      // Assemble active headers
      const activeEnvVars = state.activeEnvironmentId ? state.environments.find(e => e.id === state.activeEnvironmentId)?.variables || [] : [];
      headers.forEach((h) => {
        if (h.enabled && h.key.trim() !== "") {
          computedHeaders[h.key.trim()] = substituteEnvVars(h.value.trim(), state.envVars, activeEnvVars);
        }
      });

      let fetchBody: any = undefined;
      const subBody = substituteEnvVars(bodyValue, state.envVars, activeEnvVars);

      // Handle Request Body
      if (method !== "GET" && method !== "HEAD") {
        const hasContentType = Object.keys(computedHeaders).some(k => k.toLowerCase() === 'content-type');

        if (bodyType === "json") {
          fetchBody = subBody;
          if (!hasContentType) {
            computedHeaders["Content-Type"] = "application/json";
          }
        } else if (bodyType === "form-data") {
          const formData = new FormData();
          formParams.forEach((f) => {
            if (f.enabled && f.key.trim() !== "") {
              formData.append(f.key.trim(), substituteEnvVars(f.value, state.envVars, activeEnvVars));
            }
          });
          fetchBody = formData;
          // Let the browser set Content-Type header with the boundary
          const ctKeys = Object.keys(computedHeaders).filter(k => k.toLowerCase() === 'content-type');
          ctKeys.forEach(k => delete computedHeaders[k]);
        } else if (bodyType === "raw") {
          fetchBody = subBody;
          if (!hasContentType) {
            computedHeaders["Content-Type"] = rawType;
          }
        }
      }

      const substitutedUrl = substituteEnvVars(url, state.envVars, activeEnvVars);
      const substitutedAuthConfig = {
        bearerToken: substituteEnvVars(authConfig.bearerToken, state.envVars, activeEnvVars),
        basicUsername: substituteEnvVars(authConfig.basicUsername, state.envVars, activeEnvVars),
        basicPassword: substituteEnvVars(authConfig.basicPassword, state.envVars, activeEnvVars),
        apiKeyName: substituteEnvVars(authConfig.apiKeyName, state.envVars, activeEnvVars),
        apiKeyValue: substituteEnvVars(authConfig.apiKeyValue, state.envVars, activeEnvVars),
        apiKeyPlacement: authConfig.apiKeyPlacement,
      };

      // Apply authentication
      const authed = applyAuth(authType, substitutedAuthConfig, computedHeaders, substitutedUrl);
      computedHeaders = authed.headers;
      const finalUrl = authed.url;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

        const res = await fetch(finalUrl, {
          method,
          headers: computedHeaders,
          body: fetchBody,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const endTime = performance.now();
        const timeMs = Math.round(endTime - startTime);

        // Read response headers
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => {
          resHeaders[key] = val;
        });

        // Read response body text
        const bodyText = await res.text();
        const sizeBytes = new Blob([bodyText]).size;

        const responseObj: ApiResponse = {
          status: res.status,
          statusText: res.statusText || `HTTP ${res.status}`,
          time: timeMs,
          size: sizeBytes,
          headers: resHeaders,
          body: bodyText,
        };

        const activeHeaders = headers
          .filter(h => h.enabled && h.key.trim() !== "")
          .map(h => ({ key: h.key, value: h.value }));

        set((state) => {
          // Industry standard: History is an append-only ledger. Generate a unique ID for every execution.
          const historyId = genId();

          const newHistoryItem: HistoryItem = {
            id: historyId,
            timestamp: Date.now(),
            method,
            url,
            status: res.status,
            time: timeMs,
            headers: activeHeaders,
            bodyType,
            bodyValue: bodyType !== "none" ? bodyValue : undefined,
            formParams: bodyType === "form-data" ? formParams.filter(f => f.enabled && f.key.trim() !== "").map(f => ({ key: f.key, value: f.value })) : undefined,
            authType,
            authConfig: authType !== "none" ? { ...authConfig } : undefined,
          };

          // Prepend to history, max 100 items
          const updatedHistory = [newHistoryItem, ...state.history].slice(0, 100);
          saveStoredHistory(updatedHistory);
          return {
            history: updatedHistory,
            tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, response: responseObj, loading: false } : t)),
          };
        });
        persistTabs();

      } catch (err: any) {
        const endTime = performance.now();
        const timeMs = Math.round(endTime - startTime);
        const isAbort = err.name === "AbortError";
        const errorMsg = isAbort
          ? "⏱ Request timed out after 30 seconds."
          : err.message || "Failed to complete network request. This could be due to a CORS issue or network disconnect.";

        // Add failed entry to history
        set((state) => {
          // Industry standard: History is an append-only ledger. Generate a unique ID for every execution.
          const historyId = genId();

          const newHistoryItem: HistoryItem = {
            id: historyId,
            timestamp: Date.now(),
            method,
            url,
            error: true,
          };

          // Prepend to history, max 100 items
          const updatedHistory = [newHistoryItem, ...state.history].slice(0, 100);
          saveStoredHistory(updatedHistory);
          return {
            history: updatedHistory,
            tabs: state.tabs.map((t) => (t.id === state.activeTabId ? { ...t, error: errorMsg, loading: false } : t)),
          };
        });
      }
    },

    // Load request details from a saved history item into the active tab
    loadHistoryItem: (item) => {
      set((state) => {
        const newTab = createNewTab(`Snapshot: ${item.method}`);
        newTab.id = genId(); // Always spawn a new unique scratchpad tab from history
        newTab.method = item.method;
        newTab.url = item.url;
        
        if (item.headers && item.headers.length > 0) {
          newTab.headers = [
            ...item.headers.map(h => ({ id: genId(), key: h.key, value: h.value, enabled: true })),
            createEmptyField(),
          ];
        } else {
          newTab.headers = [createEmptyField()];
        }
        
        newTab.bodyType = item.bodyType || "none";
        newTab.bodyValue = item.bodyValue || "";
        
        if (item.formParams && item.formParams.length > 0) {
          newTab.formParams = [
            ...item.formParams.map(f => ({ id: genId(), key: f.key, value: f.value, enabled: true })),
            createEmptyField(),
          ];
        } else {
          newTab.formParams = [createEmptyField()];
        }
        
        newTab.authType = item.authType || "none";
        newTab.authConfig = item.authConfig ? { ...defaultAuthConfig, ...item.authConfig } : { ...defaultAuthConfig };
        
        return {
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
        };
      });
      get().syncParamsFromUrl(item.url);
      persistTabs();
    },

    // Clear all history
    clearHistory: () => {
      saveStoredHistory([]);
      set({ history: [] });
    },

    loadPreset: (preset) => {
      const presetId = `preset-${preset.name || "default"}`;
      const existingTab = get().tabs.find(t => t.id === presetId);
      
      if (existingTab) {
        set({ activeTabId: existingTab.id });
        return;
      }

      set((state) => {
        const newTab = createNewTab(preset.name || "Preset");
        newTab.id = presetId;
        newTab.method = preset.method;
        newTab.url = preset.url;
        newTab.bodyType = preset.bodyType || "none";
        newTab.bodyValue = preset.bodyValue || "";

        if (preset.params && preset.params.length > 0) {
          newTab.params = [
            ...preset.params.map(p => ({ id: genId(), key: p.key, value: p.value, enabled: true })),
            createEmptyField(),
          ];
        } else {
          newTab.params = [createEmptyField()];
        }

        if (preset.headers && preset.headers.length > 0) {
          newTab.headers = [
            ...preset.headers.map(h => ({ id: genId(), key: h.key, value: h.value, enabled: true })),
            createEmptyField(),
          ];
        } else {
          newTab.headers = [
            { id: genId(), key: "Content-Type", value: "application/json", enabled: true },
            createEmptyField(),
          ];
        }

        return {
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
        };
      });
      if (preset.params && preset.params.length > 0) {
        get().syncUrlFromParams();
      } else {
        get().syncParamsFromUrl(preset.url);
      }
      persistTabs();
    },

    // Collections
    importCollection: (name, requests) => {
      const newCollection: ImportedCollection = {
        id: genId(),
        name,
        requests,
      };
      set((state) => {
        const updated = [...state.collections, newCollection];
        saveStoredCollections(updated);
        return { collections: updated };
      });
    },
    removeCollection: (id) => {
      set((state) => {
        const updated = state.collections.filter((c) => c.id !== id);
        saveStoredCollections(updated);
        return { collections: updated };
      });
    },
    loadImportedRequest: (req) => {
      const targetId = req.id || genId();
      const existingTab = get().tabs.find(t => t.id === targetId);
      
      if (existingTab) {
        set({ activeTabId: existingTab.id });
        return;
      }

      set((state) => {
        const newTab = createNewTab(req.name || req.method);
        newTab.id = targetId;
        newTab.method = req.method;
        newTab.url = req.url;

        if (req.params && req.params.length > 0) {
          newTab.params = [
            ...req.params.filter(p => p.key.trim() !== "" || p.value.trim() !== "").map((p) => ({ ...p, id: genId() })),
            createEmptyField(),
          ];
        }

        if (req.headers && req.headers.length > 0) {
          newTab.headers = [
            ...req.headers.filter(h => h.key.trim() !== "" || h.value.trim() !== "").map((h) => ({ ...h, id: genId() })),
            createEmptyField(),
          ];
        }

        if (req.formParams && req.formParams.length > 0) {
          newTab.formParams = [
            ...req.formParams.filter(f => f.key.trim() !== "" || f.value.trim() !== "").map((f) => ({ ...f, id: genId() })),
            createEmptyField(),
          ];
        }

        newTab.bodyType = req.bodyType || "none";
        newTab.bodyValue = req.bodyValue || "";
        newTab.rawType = req.rawType || "text/plain";
        newTab.authType = req.authType || "none";
        newTab.authConfig = { ...defaultAuthConfig, ...(req.authConfig || {}) };

        return {
          tabs: [...state.tabs, newTab],
          activeTabId: newTab.id,
        };
      });
      get().syncUrlFromParams();
      persistTabs();
    },

    // Format JSON request body helper
    formatActiveTabJsonBody: () => {
      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id === state.activeTabId && t.bodyType === "json") {
            try {
              const beautified = JSON.stringify(JSON.parse(t.bodyValue), null, 2);
              return { ...t, bodyValue: beautified };
            } catch {
              // Ignore invalid JSON formatting requests
            }
          }
          return t;
        }),
      }));
      persistTabs();
    },

    // POSIX-compliant cURL parser & importer
    importFromCurl: (curlStr) => {
      const cleaned = curlStr.replace(/\\\r?\n/g, " ").trim();
      if (!cleaned.toLowerCase().startsWith("curl")) {
        return false;
      }

      // Simple argument tokenizer supporting single/double quotes and backslash escapes
      const args: string[] = [];
      let current = "";
      let inDouble = false;
      let inSingle = false;
      let escaped = false;

      for (let i = 0; i < cleaned.length; i++) {
        const char = cleaned[i];
        if (escaped) {
          current += char;
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"' && !inSingle) {
          inDouble = !inDouble;
          continue;
        }
        if (char === "'" && !inDouble) {
          inSingle = !inSingle;
          continue;
        }
        if ((char === " " || char === "\t") && !inDouble && !inSingle) {
          if (current.length > 0) {
            args.push(current);
            current = "";
          }
        } else {
          current += char;
        }
      }
      if (current.length > 0) {
        args.push(current);
      }

      let method: HttpMethod = "GET";
      let url = "";
      const headers: KeyValueField[] = [];
      let bodyType: BodyType = "none";
      let bodyValue = "";
      const formParams: KeyValueField[] = [];

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (!arg) continue;
        const nextArg = args[i + 1] || "";

        if (arg === "-X" || arg === "--request") {
          const m = nextArg.toUpperCase();
          if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(m)) {
            method = m as HttpMethod;
          }
          i++;
        } else if (arg === "-H" || arg === "--header") {
          const colonIdx = nextArg.indexOf(":");
          if (colonIdx !== -1) {
            headers.push({
              id: genId(),
              key: nextArg.substring(0, colonIdx).trim(),
              value: nextArg.substring(colonIdx + 1).trim(),
              enabled: true,
            });
          }
          i++;
        } else if (arg === "-d" || arg === "--data" || arg === "--data-raw" || arg === "--data-binary") {
          bodyType = "json";
          bodyValue = nextArg;
          if (method === "GET") {
            method = "POST";
          }
          i++;
        } else if (arg === "-F" || arg === "--form") {
          bodyType = "form-data";
          const eqIdx = nextArg.indexOf("=");
          if (eqIdx !== -1) {
            formParams.push({
              id: genId(),
              key: nextArg.substring(0, eqIdx).trim(),
              value: nextArg.substring(eqIdx + 1).trim(),
              enabled: true,
            });
          }
          if (method === "GET") {
            method = "POST";
          }
          i++;
        } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
          url = arg;
        } else if (!arg.startsWith("-") && !url) {
          url = arg;
        }
      }

      if (!url) return false;

      // Determine precise JSON vs raw body
      if (bodyType === "json" && bodyValue) {
        try {
          JSON.parse(bodyValue);
        } catch {
          bodyType = "raw";
        }
      }

      // Add default content-type header if missing for JSON bodies
      const hasContentType = headers.some(h => h.key.toLowerCase() === "content-type");
      if (bodyType === "json" && !hasContentType) {
        headers.push({ id: genId(), key: "Content-Type", value: "application/json", enabled: true });
      }

      headers.push(createEmptyField());
      formParams.push(createEmptyField());

      set((state) => ({
        tabs: state.tabs.map((t) => {
          if (t.id === state.activeTabId) {
            return {
              ...t,
              method,
              url,
              headers,
              bodyType,
              bodyValue,
              formParams,
              authType: "none",
            };
          }
          return t;
        }),
      }));

      get().syncParamsFromUrl(url);
      persistTabs();
      return true;
    },
    
    exportTabsAsZip: async (tabIds: string[]) => {
      const { tabs } = get();
      const tabsToExport = tabs.filter(t => tabIds.includes(t.id));
      if (tabsToExport.length === 0) return;
      
      const zip = new JSZip();
      tabsToExport.forEach(tab => {
        const exportData = {
          id: tab.id,
          name: tab.name,
          method: tab.method,
          url: tab.url,
          params: tab.params,
          headers: tab.headers,
          bodyType: tab.bodyType,
          bodyValue: tab.bodyValue,
          formParams: tab.formParams,
          rawType: tab.rawType,
          authType: tab.authType,
          authConfig: tab.authConfig
        };
        
        const safeName = tab.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'request';
        const filename = `${safeName}_${tab.id.substring(0, 6)}.json`;
        
        zip.file(filename, JSON.stringify(exportData, null, 2));
      });
      
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `api_exports_${new Date().getTime()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    setEnvVars: (vars: KeyValueField[]) => {
      saveStoredEnvVars(vars);
      set({ envVars: vars });
    },
    
    // Multi-Environment
    addEnvironment: (name: string) => {
      const newId = genId();
      set((state) => {
        const newEnv: Environment = {
          id: newId,
          name,
          variables: [createEmptyField()]
        };
        const updated = [...state.environments, newEnv];
        saveStoredEnvironments(updated);
        return { environments: updated };
      });
      return newId;
    },
    
    updateEnvironment: (id: string, name: string) => {
      set((state) => {
        const updated = state.environments.map(e => e.id === id ? { ...e, name } : e);
        saveStoredEnvironments(updated);
        return { environments: updated };
      });
    },
    
    removeEnvironment: (id: string) => {
      set((state) => {
        const updated = state.environments.filter(e => e.id !== id);
        saveStoredEnvironments(updated);
        return { 
          environments: updated,
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId
        };
      });
    },
    
    setActiveEnvironment: (id: string | null) => {
      saveStoredActiveEnvId(id);
      set({ activeEnvironmentId: id });
    },
    
    setEnvironmentVars: (id: string, vars: KeyValueField[]) => {
      set((state) => {
        const updated = state.environments.map(e => e.id === id ? { ...e, variables: vars } : e);
        saveStoredEnvironments(updated);
        return { environments: updated };
      });
    }
  };
});
