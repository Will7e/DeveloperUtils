// ============================================================
// Cloud Sync — Zustand Store
// ============================================================
// UI-facing state for the cloud sync feature. Persisted fields
// (provider choice, connection flag, sync schedule) are stored
// via the existing encrypted storage; tokens are persisted
// separately (vault-encrypted) because they need their own
// rotation lifecycle.

import { create } from "zustand";
import type { CloudProviderId, OAuthTokens, SyncDomain, SyncStatus } from "./types";
import { SYNC_DOMAINS } from "./types";

const PRESENCE_KEY = "intab_cloudsync_presence";

/** All domains enabled — the default for fresh profiles and legacy presence. */
function allDomainsEnabled(): Record<SyncDomain, boolean> {
  return { appState: true, apiTester: true, chat: true };
}

/** Normalizes a stored presence payload's domain flags (missing → enabled). */
function normalizeDomains(raw: unknown): Record<SyncDomain, boolean> {
  const defaults = allDomainsEnabled();
  if (!raw || typeof raw !== "object") return defaults;
  const record = raw as Partial<Record<SyncDomain, unknown>>;
  const out = defaults;
  for (const domain of SYNC_DOMAINS) {
    if (typeof record[domain] === "boolean") out[domain] = record[domain] as boolean;
  }
  return out;
}

interface PersistedPresence {
  provider: CloudProviderId | null;
  isConnected: boolean;
  syncSchedule: SyncSchedule;
  syncDomains: Record<SyncDomain, boolean>;
}

export type SyncSchedule = "realtime" | "manual";

export interface CloudSyncStoreState {
  // Connection state (hydrated from vault-encrypted token storage)
  provider: CloudProviderId | null;
  tokens: OAuthTokens | null;
  isConnected: boolean;
  isConnecting: boolean;

  // Premium linkage
  licenseKey: string | null;
  licenseFp: string | null;

  // Sync status
  status: SyncStatus;
  lastSyncedAt: number | null;
  lastError: string | null;
  error: string | null;

  // Multi-tab role
  multiTabRole: "leader" | "follower" | null;

  // Schedule preference
  syncSchedule: SyncSchedule;

  // Per-domain sync selection (which data categories sync to the drive)
  syncDomains: Record<SyncDomain, boolean>;

  // Actions
  setLicense: (key: string | null, fp: string | null) => void;
  setConnecting: (connecting: boolean) => void;
  setStatus: (status: SyncStatus, lastError?: string | null) => void;
  setMultiTabRole: (role: "leader" | "follower" | null) => void;
  setSyncSchedule: (schedule: SyncSchedule) => void;
  setSyncDomain: (domain: SyncDomain, enabled: boolean) => void;
  hydratePresence: () => void;
}

function loadPresence(): PersistedPresence {
  try {
    const raw = localStorage.getItem(PRESENCE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedPresence;
      return {
        provider: parsed.provider ?? null,
        isConnected: Boolean(parsed.isConnected),
        syncSchedule: parsed.syncSchedule === "manual" ? "manual" : "realtime",
        syncDomains: normalizeDomains(parsed.syncDomains),
      };
    }
  } catch {
    /* fallthrough */
  }
  return { provider: null, isConnected: false, syncSchedule: "realtime", syncDomains: allDomainsEnabled() };
}

function savePresence(presence: PersistedPresence): void {
  try {
    localStorage.setItem(PRESENCE_KEY, JSON.stringify(presence));
  } catch {
    /* non-critical */
  }
}

const initialPresence = loadPresence();

export const useCloudSyncStore = create<CloudSyncStoreState>((set, get) => ({
  provider: initialPresence.provider,
  tokens: null,
  isConnected: false, // becomes true after engine restore succeeds
  isConnecting: false,

  licenseKey: null,
  licenseFp: null,

  status: "idle",
  lastSyncedAt: null,
  lastError: null,
  error: null,

  multiTabRole: null,

  syncSchedule: initialPresence.syncSchedule,
  syncDomains: initialPresence.syncDomains,

  setLicense: (key, fp) => {
    set({ licenseKey: key, licenseFp: fp });
  },

  setConnecting: (connecting) => {
    set({ isConnecting: connecting });
  },

  setStatus: (status, lastError = null) => {
    set({ status, lastError });
  },

  setMultiTabRole: (role) => {
    set({ multiTabRole: role });
  },

  setSyncSchedule: (schedule) => {
    set({ syncSchedule: schedule });
    savePresence({
      provider: get().provider,
      isConnected: get().isConnected,
      syncSchedule: schedule,
      syncDomains: get().syncDomains,
    });
  },

  setSyncDomain: (domain, enabled) => {
    set({ syncDomains: { ...get().syncDomains, [domain]: enabled } });
    savePresence({
      provider: get().provider,
      isConnected: get().isConnected,
      syncSchedule: get().syncSchedule,
      syncDomains: get().syncDomains,
    });
  },

  hydratePresence: () => {
    const presence = loadPresence();
    set({
      provider: presence.provider,
      syncSchedule: presence.syncSchedule,
      syncDomains: presence.syncDomains,
    });
  },
}));

/** Persists connection presence so the UI can show "reconnecting…" states. */
export function persistPresence(
  state: Pick<CloudSyncStoreState, "provider" | "isConnected" | "syncSchedule" | "syncDomains">
): void {
  savePresence({
    provider: state.provider,
    isConnected: state.isConnected,
    syncSchedule: state.syncSchedule,
    syncDomains: state.syncDomains,
  });
}
