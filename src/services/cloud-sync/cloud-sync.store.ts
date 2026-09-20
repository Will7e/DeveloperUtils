// ============================================================
// Cloud Sync — Zustand Store
// ============================================================
// UI-facing state for the cloud sync feature. Persisted fields
// (provider choice, connection flag, sync schedule) are stored
// via the existing encrypted storage; tokens are persisted
// separately (vault-encrypted) because they need their own
// rotation lifecycle.

import { create } from "zustand";
import type { CloudProviderId, OAuthTokens, SyncStatus } from "./types";

const PRESENCE_KEY = "intab_cloudsync_presence";

interface PersistedPresence {
  provider: CloudProviderId | null;
  isConnected: boolean;
  syncSchedule: SyncSchedule;
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

  // Actions
  setLicense: (key: string | null, fp: string | null) => void;
  setConnecting: (connecting: boolean) => void;
  setStatus: (status: SyncStatus, lastError?: string | null) => void;
  setMultiTabRole: (role: "leader" | "follower" | null) => void;
  setSyncSchedule: (schedule: SyncSchedule) => void;
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
      };
    }
  } catch {
    /* fallthrough */
  }
  return { provider: null, isConnected: false, syncSchedule: "realtime" };
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
    });
  },

  hydratePresence: () => {
    const presence = loadPresence();
    set({
      provider: presence.provider,
      syncSchedule: presence.syncSchedule,
    });
  },
}));

/** Persists connection presence so the UI can show "reconnecting…" states. */
export function persistPresence(state: Pick<CloudSyncStoreState, "provider" | "isConnected" | "syncSchedule">): void {
  savePresence({
    provider: state.provider,
    isConnected: state.isConnected,
    syncSchedule: state.syncSchedule,
  });
}
