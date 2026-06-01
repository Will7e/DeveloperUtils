import { TabState, HistoryItem, ImportedCollection, Environment, KeyValueField } from "./api-tester.store";

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
}

// Simulate network latency (0ms for now so it doesn't feel sluggish, but uses Promises to simulate async)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalStorageAdapter implements StorageAdapter {
  async getTabs(): Promise<{ tabs: TabState[]; activeTabId: string } | null> {
    await delay(0);
    try {
      const saved = localStorage.getItem("devutils_api_tabs");
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
    await delay(0);
    try {
      const serializable = tabs.map(t => ({ ...t, loading: false, error: null }));
      localStorage.setItem("devutils_api_tabs", JSON.stringify({ tabs: serializable, activeTabId }));
    } catch (e) {
      console.error("Failed to save tabs", e);
    }
  }

  async getHistory(): Promise<HistoryItem[]> {
    await delay(0);
    try {
      const saved = localStorage.getItem("devutils_api_history");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveHistory(history: HistoryItem[]): Promise<void> {
    await delay(0);
    try {
      localStorage.setItem("devutils_api_history", JSON.stringify(history));
    } catch (e) {
      console.error("Failed to save history", e);
    }
  }

  async getCollections(): Promise<ImportedCollection[]> {
    await delay(0);
    try {
      const saved = localStorage.getItem("devutils_api_collections");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveCollections(collections: ImportedCollection[]): Promise<void> {
    await delay(0);
    try {
      localStorage.setItem("devutils_api_collections", JSON.stringify(collections));
    } catch (e) {
      console.error("Failed to save collections", e);
    }
  }

  async getEnvVars(): Promise<KeyValueField[]> {
    await delay(0);
    try {
      const saved = localStorage.getItem("devutils_api_env_vars");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveEnvVars(vars: KeyValueField[]): Promise<void> {
    await delay(0);
    try {
      localStorage.setItem("devutils_api_env_vars", JSON.stringify(vars));
    } catch (e) {
      console.error("Failed to save env vars", e);
    }
  }

  async getEnvironments(): Promise<Environment[]> {
    await delay(0);
    try {
      const saved = localStorage.getItem("devutils_api_environments");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  async saveEnvironments(envs: Environment[]): Promise<void> {
    await delay(0);
    try {
      localStorage.setItem("devutils_api_environments", JSON.stringify(envs));
    } catch (e) {
      console.error("Failed to save environments", e);
    }
  }

  async getActiveEnvId(): Promise<string | null> {
    await delay(0);
    try {
      const saved = localStorage.getItem("devutils_api_active_env");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }

  async saveActiveEnvId(id: string | null): Promise<void> {
    await delay(0);
    try {
      localStorage.setItem("devutils_api_active_env", JSON.stringify(id));
    } catch (e) {
      console.error("Failed to save active env id", e);
    }
  }
}

export const apiStorage: StorageAdapter = new LocalStorageAdapter();
