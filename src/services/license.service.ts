// ============================================================
// License Service — InTab Premium ($3/mo)
// ============================================================
// License-key based premium gate powered by Lemon Squeezy.
// No user accounts: the license key itself is the credential.
// Validation goes through our edge function (api/license.ts) so
// the Lemon Squeezy API key never ships to the browser.
//
// Client behavior:
//  - Activate: POST { licenseKey } → edge fn activates + validates
//  - Cache: { valid, expiresAt } in localStorage (7-day offline grace)
//  - Revalidate: every 72h and on app boot (non-blocking)

import { create } from "zustand";

const LICENSE_STATE_KEY = "intab_premium_state";
const REVALIDATE_INTERVAL_MS = 72 * 60 * 60 * 1000; // 72h
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface LicenseState {
  licenseKey: string | null;
  isValid: boolean;
  expiresAt: number | null;
  lastValidatedAt: number | null;
  isActivating: boolean;
  error: string | null;

  activate: (licenseKey: string) => Promise<boolean>;
  deactivate: () => void;
  revalidate: () => Promise<boolean>;
  hasValidLicense: () => boolean;
}

interface PersistedLicenseState {
  licenseKey: string | null;
  isValid: boolean;
  expiresAt: number | null;
  lastValidatedAt: number | null;
}

function loadPersisted(): PersistedLicenseState {
  try {
    const raw = localStorage.getItem(LICENSE_STATE_KEY);
    if (raw) return JSON.parse(raw) as PersistedLicenseState;
  } catch {
    /* fallthrough */
  }
  return { licenseKey: null, isValid: false, expiresAt: null, lastValidatedAt: null };
}

function persist(state: PersistedLicenseState): void {
  try {
    localStorage.setItem(LICENSE_STATE_KEY, JSON.stringify(state));
  } catch {
    /* non-critical */
  }
}

export const useLicenseStore = create<LicenseState>((set, get) => ({
  ...loadPersisted(),
  isActivating: false,
  error: null,

  activate: async (licenseKey) => {
    const trimmed = licenseKey.trim();
    if (!trimmed) {
      set({ error: "Please enter your license key." });
      return false;
    }

    set({ isActivating: true, error: null });
    try {
      const res = await fetch("/api/license", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey: trimmed }),
      });

      // Robust parsing: error responses may be HTML (dev 404/SPA fallback) or text
      let json: { valid?: boolean; error?: string; expiresAt?: number | null };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        json = { valid: false, error: `License service unreachable (HTTP ${res.status}).` };
      }

      if (!res.ok || !json.valid) {
        set({
          isActivating: false,
          error: json.error || "License activation failed. Please check your key.",
        });
        return false;
      }

      const next: PersistedLicenseState = {
        licenseKey: trimmed,
        isValid: true,
        expiresAt: json.expiresAt ?? null,
        lastValidatedAt: Date.now(),
      };
      persist(next);
      set({ ...next, isActivating: false, error: null });

      // Live rekey: propagate to an active cloud-sync connection immediately
      void (async () => {
        try {
          const { rekeyAfterLicenseChange } = await import("@/services/cloud-sync/sync-engine");
          await rekeyAfterLicenseChange();
        } catch (err) {
          console.warn("Sync rekey after activation failed:", err);
        }
      })();

      return true;
    } catch (err) {
      set({
        isActivating: false,
        error: err instanceof Error ? err.message : "Network error during activation.",
      });
      return false;
    }
  },

  deactivate: () => {
    persist({ licenseKey: null, isValid: false, expiresAt: null, lastValidatedAt: null });
    set({ licenseKey: null, isValid: false, expiresAt: null, lastValidatedAt: null });

    // Live rekey back to the default at-rest key
    void (async () => {
      try {
        const { rekeyAfterLicenseChange } = await import("@/services/cloud-sync/sync-engine");
        await rekeyAfterLicenseChange();
      } catch (err) {
        console.warn("Sync rekey after deactivation failed:", err);
      }
    })();
  },

  revalidate: async () => {
    const { licenseKey, lastValidatedAt } = get();
    if (!licenseKey) return false;

    // Offline grace window
    if (lastValidatedAt && Date.now() - lastValidatedAt > OFFLINE_GRACE_MS) {
      set({ isValid: false });
      persist({ ...get(), isValid: false, expiresAt: get().expiresAt, lastValidatedAt: get().lastValidatedAt });
      return false;
    }

    // Skip when recently validated
    if (lastValidatedAt && Date.now() - lastValidatedAt < REVALIDATE_INTERVAL_MS) {
      return get().isValid;
    }

    try {
      const res = await fetch("/api/license", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey }),
      });
      const json = (await res.json()) as { valid: boolean; expiresAt?: number | null };
      const next: PersistedLicenseState = {
        licenseKey,
        isValid: Boolean(json.valid),
        expiresAt: json.expiresAt ?? null,
        lastValidatedAt: Date.now(),
      };
      persist(next);
      set(next);
      return next.isValid;
    } catch {
      // Network error: keep current state (grace already checked above)
      return get().isValid;
    }
  },

  hasValidLicense: () => {
    const { isValid, licenseKey } = get();
    return isValid && Boolean(licenseKey);
  },
}));
