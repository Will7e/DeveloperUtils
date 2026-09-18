// ============================================================
// Bootstrap Service — Unified Application Readiness Coordinator
// ============================================================
// Coordinates critical resources (Monaco runtime, store hydration,
// and vault check) under a single initial loading screen, then
// dismisses the splash screen smoothly with zero secondary loaders.

import { loader } from "@monaco-editor/react";
import { setupMonacoTheme } from "@/utils/monaco-theme";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { useVaultStore } from "@/services/vault.service";

declare global {
  interface Window {
    __DEVUTILS_DISMISS_LOADER__?: () => void;
    __DEVUTILS_LOADER_DISMISSED__?: boolean;
    __DEVUTILS_BOOTSTRAP_PROMISE__?: Promise<void>;
  }
}

let bootstrapPromise: Promise<void> | null = null;

/**
 * Pre-initializes the Monaco Editor runtime and registers custom themes.
 * Cached so subsequent calls reuse the same promise.
 */
let monacoInitPromise: Promise<unknown> | null = null;
export function initMonacoRuntime(): Promise<unknown> {
  if (!monacoInitPromise) {
    monacoInitPromise = loader
      .init()
      .then((monaco) => {
        setupMonacoTheme(monaco);
        return monaco;
      })
      .catch((err) => {
        console.warn("Monaco initialization note:", err);
      });
  }
  return monacoInitPromise;
}

/**
 * Coordinates all critical tasks for the initial page load.
 * Guarantees that only 1 loading screen is displayed across the page.
 */
export function bootstrapApp(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
    const isApiTester = pathname.startsWith("/api-tester");

    // 1. Always kick off vault automatic initialization
    const vaultPromise = useVaultStore.getState().initAutomaticVault().catch((err) => {
      console.warn("Vault initialization note:", err);
    });

    // 2. Monaco runtime initialization (critical for compiler, api-tester, formatters, diff)
    const monacoPromise = initMonacoRuntime();

    // 3. Page-specific store hydration
    let pagePromise: Promise<unknown>;
    if (isApiTester) {
      // Must await api tester store before revealing the /api-tester view
      pagePromise = useApiTesterStore.getState().init().catch((err) => {
        console.warn("API Tester store init note:", err);
      });
    } else {
      // Don't eagerly init API Tester on other routes — it will init when navigating to /api-tester
      pagePromise = Promise.resolve();
    }

    // 4. Critical tasks to wait for before opening the single loading gate
    const criticalTasks = [vaultPromise, monacoPromise, pagePromise];

    // Cap the waiting time to 2.2 seconds maximum to prevent hanging on slow/offline networks
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2200));

    await Promise.race([
      Promise.allSettled(criticalTasks),
      timeoutPromise,
    ]);

    // 5. Trigger a smooth fade-out of the single splash screen
    if (typeof window !== "undefined" && window.__DEVUTILS_DISMISS_LOADER__) {
      window.__DEVUTILS_DISMISS_LOADER__();
    }
  })();

  if (typeof window !== "undefined") {
    window.__DEVUTILS_BOOTSTRAP_PROMISE__ = bootstrapPromise;
  }

  return bootstrapPromise;
}
