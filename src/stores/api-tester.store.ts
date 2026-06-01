// ============================================================
// API Tester Store — State management for the REST Client
// ============================================================

import { create } from "zustand";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export type BodyType = "none" | "json" | "form-data" | "raw";

export interface KeyValueField {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  method: HttpMethod;
  url: string;
  status?: number;
  time?: number;
  error?: boolean;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  time: number; // in ms
  size: number; // in bytes
  headers: Record<string, string>;
  body: string;
}

interface ApiTesterState {
  method: HttpMethod;
  url: string;
  params: KeyValueField[];
  headers: KeyValueField[];
  bodyType: BodyType;
  bodyValue: string;
  formParams: KeyValueField[];
  rawType: string;
  response: ApiResponse | null;
  loading: boolean;
  error: string | null;
  history: HistoryItem[];

  // Setters
  setMethod: (method: HttpMethod) => void;
  setUrl: (url: string) => void;
  setBodyType: (type: BodyType) => void;
  setBodyValue: (value: string) => void;
  setRawType: (type: string) => void;

  // Key-value editors
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
  
  // History & Presets
  loadHistoryItem: (item: HistoryItem) => void;
  clearHistory: () => void;
  loadPreset: (preset: {
    method: HttpMethod;
    url: string;
    headers?: Array<{ key: string; value: string }>;
    params?: Array<{ key: string; value: string }>;
    bodyType?: BodyType;
    bodyValue?: string;
  }) => void;
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

// Load history from LocalStorage
const loadStoredHistory = (): HistoryItem[] => {
  try {
    const saved = localStorage.getItem("devutils_api_history");
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
};

// Save history to LocalStorage
const saveStoredHistory = (history: HistoryItem[]) => {
  try {
    localStorage.setItem("devutils_api_history", JSON.stringify(history));
  } catch (e) {
    console.error("Failed to save history", e);
  }
};

export const useApiTesterStore = create<ApiTesterState>((set, get) => ({
  method: "GET",
  url: "https://jsonplaceholder.typicode.com/users",
  params: [createEmptyField()],
  headers: [
    { id: genId(), key: "Content-Type", value: "application/json", enabled: true },
    createEmptyField(),
  ],
  bodyType: "none",
  bodyValue: "{\n  \"name\": \"John Doe\",\n  \"email\": \"john@example.com\"\n}",
  formParams: [createEmptyField()],
  rawType: "text/plain",
  response: null,
  loading: false,
  error: null,
  history: loadStoredHistory(),

  setMethod: (method) => set({ method }),
  
  setUrl: (url) => {
    set({ url });
    // Also sync the Params table when url changes manually
    get().syncParamsFromUrl(url);
  },

  setBodyType: (bodyType) => set({ bodyType }),
  setBodyValue: (bodyValue) => set({ bodyValue }),
  setRawType: (rawType) => set({ rawType }),

  // Params actions
  addParam: () => set((state) => ({ params: [...state.params, createEmptyField()] })),
  updateParam: (id, updates) => {
    set((state) => ({
      params: state.params.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    }));
    get().syncUrlFromParams();
  },
  removeParam: (id) => {
    set((state) => {
      const filtered = state.params.filter((p) => p.id !== id);
      return { params: filtered.length === 0 ? [createEmptyField()] : filtered };
    });
    get().syncUrlFromParams();
  },

  // Headers actions
  addHeader: () => set((state) => ({ headers: [...state.headers, createEmptyField()] })),
  updateHeader: (id, updates) =>
    set((state) => ({
      headers: state.headers.map((h) => (h.id === id ? { ...h, ...updates } : h)),
    })),
  removeHeader: (id) =>
    set((state) => {
      const filtered = state.headers.filter((h) => h.id !== id);
      return { headers: filtered.length === 0 ? [createEmptyField()] : filtered };
    }),

  // Form Data actions
  addFormParam: () => set((state) => ({ formParams: [...state.formParams, createEmptyField()] })),
  updateFormParam: (id, updates) =>
    set((state) => ({
      formParams: state.formParams.map((f) => (f.id === id ? { ...f, ...updates } : f)),
    })),
  removeFormParam: (id) =>
    set((state) => {
      const filtered = state.formParams.filter((f) => f.id !== id);
      return { formParams: filtered.length === 0 ? [createEmptyField()] : filtered };
    }),

  // Sync logic: URL -> Params
  syncParamsFromUrl: (urlStr) => {
    try {
      if (!urlStr || !urlStr.includes("?")) return;
      const queryString = urlStr.substring(urlStr.indexOf("?") + 1);
      const searchParams = new URLSearchParams(queryString);
      
      const newParams: KeyValueField[] = [];
      searchParams.forEach((value, key) => {
        newParams.push({ id: genId(), key, value, enabled: true });
      });

      if (newParams.length > 0) {
        newParams.push(createEmptyField()); // Extra empty row at end
        set({ params: newParams });
      }
    } catch {
      // Invalid URL or error parsing search string, fail silently
    }
  },

  // Sync logic: Params -> URL
  syncUrlFromParams: () => {
    const { url, params } = get();
    try {
      let baseUrl = url;
      if (url.includes("?")) {
        baseUrl = url.substring(0, url.indexOf("?"));
      }

      const activeParams = params.filter((p) => p.enabled && p.key.trim() !== "");
      if (activeParams.length === 0) {
        set({ url: baseUrl });
        return;
      }

      const searchParams = new URLSearchParams();
      activeParams.forEach((p) => {
        searchParams.append(p.key.trim(), p.value.trim());
      });

      set({ url: `${baseUrl}?${searchParams.toString()}` });
    } catch {
      // Fail silently
    }
  },

  // Send request using standard window.fetch (the industry standard for lightweight browser clients)
  sendRequest: async () => {
    const { method, url, params, headers, bodyType, bodyValue, formParams, rawType } = get();
    set({ loading: true, error: null, response: null });

    const startTime = performance.now();
    let computedHeaders: Record<string, string> = {};

    // Assemble active headers
    headers.forEach((h) => {
      if (h.enabled && h.key.trim() !== "") {
        computedHeaders[h.key.trim()] = h.value.trim();
      }
    });

    let fetchBody: any = undefined;

    // Handle Request Body
    if (method !== "GET" && method !== "HEAD") {
      if (bodyType === "json") {
        fetchBody = bodyValue;
        if (!computedHeaders["Content-Type"]) {
          computedHeaders["Content-Type"] = "application/json";
        }
      } else if (bodyType === "form-data") {
        const formData = new FormData();
        formParams.forEach((f) => {
          if (f.enabled && f.key.trim() !== "") {
            formData.append(f.key.trim(), f.value.trim());
          }
        });
        fetchBody = formData;
        // Let the browser set Content-Type header with the boundary
        delete computedHeaders["Content-Type"];
      } else if (bodyType === "raw") {
        fetchBody = bodyValue;
        if (!computedHeaders["Content-Type"]) {
          computedHeaders["Content-Type"] = rawType;
        }
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const res = await fetch(url, {
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

      // Add to history
      const newHistoryItem: HistoryItem = {
        id: genId(),
        timestamp: Date.now(),
        method,
        url,
        status: res.status,
        time: timeMs,
      };

      set((state) => {
        const updatedHistory = [newHistoryItem, ...state.history].slice(0, 50);
        saveStoredHistory(updatedHistory);
        return {
          response: responseObj,
          loading: false,
          history: updatedHistory,
        };
      });

    } catch (err: any) {
      const endTime = performance.now();
      const timeMs = Math.round(endTime - startTime);
      const isAbort = err.name === "AbortError";
      const errorMsg = isAbort
        ? "⏱ Request timed out after 30 seconds."
        : err.message || "Failed to complete network request. This could be due to a CORS issue or network disconnect.";

      // Add failed entry to history
      const newHistoryItem: HistoryItem = {
        id: genId(),
        timestamp: Date.now(),
        method,
        url,
        error: true,
      };

      set((state) => {
        const updatedHistory = [newHistoryItem, ...state.history].slice(0, 50);
        saveStoredHistory(updatedHistory);
        return {
          error: errorMsg,
          loading: false,
          history: updatedHistory,
        };
      });
    }
  },

  // Load request details from a saved history item
  loadHistoryItem: (item) => {
    // If the saved URL contains query params, we parse them
    set({
      method: item.method,
      url: item.url,
      response: null,
      error: null,
    });
    get().syncParamsFromUrl(item.url);
  },

  // Clear all history
  clearHistory: () => {
    saveStoredHistory([]);
    set({ history: [] });
  },

  // Load template presets
  loadPreset: (preset) => {
    const formattedParams = preset.params && preset.params.length > 0
      ? [...preset.params.map(p => ({ id: genId(), key: p.key, value: p.value, enabled: true })), createEmptyField()]
      : [createEmptyField()];

    const formattedHeaders = preset.headers && preset.headers.length > 0
      ? [...preset.headers.map(h => ({ id: genId(), key: h.key, value: h.value, enabled: true })), createEmptyField()]
      : [{ id: genId(), key: "Content-Type", value: "application/json", enabled: true }, createEmptyField()];

    set({
      method: preset.method,
      url: preset.url,
      params: formattedParams,
      headers: formattedHeaders,
      bodyType: preset.bodyType || "none",
      bodyValue: preset.bodyValue || "",
      response: null,
      error: null,
    });

    if (preset.params && preset.params.length > 0) {
      get().syncUrlFromParams();
    }
  },
}));
