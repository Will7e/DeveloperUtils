// ============================================================
// API Tester — Cloud Sync Snapshot Bridge
// ============================================================
// The API tester store persists through its own StorageAdapter
// (api-tester.storage.ts). This bridge collects the persisted
// values from localStorage and applies remote snapshots by
// writing through the same adapter, keeping field-level
// vault encryption and legacy key fallbacks intact.

import { apiStorage } from "./api-tester.storage";
import { readValue } from "@/services/idb-storage.service";
import type { TabState, HistoryItem, ImportedCollection, Environment, KeyValueField } from "./api-tester.store";

const TABS_KEY = "intab_api_tabs";

/** Collected snapshot of every persisted API tester value. */
export interface ApiTesterSyncSnapshot {
  tabs: { tabs: TabState[]; activeTabId: string } | null;
  history: HistoryItem[];
  collections: ImportedCollection[];
  envVars: KeyValueField[];
  environments: Environment[];
  activeEnvId: string | null;
  customPresets: unknown[];
  addedPresetIds: string[];
  customProxyUrl: string | null;
}

/** Reads the persisted API tester state (decrypting sensitive fields). */
export async function getApiTesterSnapshot(): Promise<ApiTesterSyncSnapshot> {
  const [tabs, history, collections, envVars, environments, activeEnvId, customPresets, addedPresetIds, customProxyUrl] =
    await Promise.all([
      apiStorage.getTabs(),
      apiStorage.getHistory(),
      apiStorage.getCollections(),
      apiStorage.getEnvVars(),
      apiStorage.getEnvironments(),
      apiStorage.getActiveEnvId(),
      apiStorage.getCustomPresets(),
      apiStorage.getAddedPresetIds(),
      apiStorage.getCustomProxyUrl(),
    ]);

  return {
    tabs,
    history,
    collections,
    envVars,
    environments,
    activeEnvId,
    customPresets,
    addedPresetIds,
    customProxyUrl,
  };
}

/**
 * Applies a remote snapshot by writing through the storage adapter.
 * The in-memory store picks changes up via the engine's storage-signature
 * poll → push loop, so no direct store writes are needed here.
 */
export async function applyApiTesterSnapshot(snapshot: unknown): Promise<void> {
  if (!snapshot || typeof snapshot !== "object") return;
  const snap = snapshot as Partial<ApiTesterSyncSnapshot>;

  try {
    if (snap.tabs && Array.isArray(snap.tabs.tabs)) {
      await apiStorage.saveTabs(snap.tabs.tabs, snap.tabs.activeTabId);
    }
    if (Array.isArray(snap.history)) await apiStorage.saveHistory(snap.history);
    if (Array.isArray(snap.collections)) await apiStorage.saveCollections(snap.collections);
    if (Array.isArray(snap.envVars)) await apiStorage.saveEnvVars(snap.envVars);
    if (Array.isArray(snap.environments)) await apiStorage.saveEnvironments(snap.environments);
    if (snap.activeEnvId !== undefined) await apiStorage.saveActiveEnvId(snap.activeEnvId ?? null);
    if (Array.isArray(snap.customPresets)) await apiStorage.saveCustomPresets(snap.customPresets as never);
    if (Array.isArray(snap.addedPresetIds)) await apiStorage.saveAddedPresetIds(snap.addedPresetIds);
    if (snap.customProxyUrl !== undefined) await apiStorage.saveCustomProxyUrl(snap.customProxyUrl ?? null);
  } catch (err) {
    console.warn("API tester snapshot apply failed:", err);
  }
}

/** Whether the API tester store has already hydrated from storage. */
export async function isApiTesterInitialized(): Promise<boolean> {
  try {
    const raw = await readValue(TABS_KEY);
    return Boolean(raw);
  } catch {
    return false;
  }
}

export { TABS_KEY };
