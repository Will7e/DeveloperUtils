// ============================================================
// Cloud Sync — Engine
// ============================================================
// Orchestrates background sync between the two local persistence
// stacks (app store + API tester) and the connected cloud provider.
//
// Design:
//  - Push: debounced (3s idle) encrypted snapshot upload, latest-only
//  - Pull: on boot / tab visible / interval / manual "Sync now"
//  - Concurrency: manifest `rev` + tombstones; conflicts archived
//  - Multi-tab: BroadcastChannel leader election (only leader syncs)
//  - Offline: navigator.onLine listeners + retry with backoff

import { getSyncCryptoKey, encryptSnapshotTagged, decryptSnapshot, decryptSnapshotTagged, clearSyncCryptoKey, licenseFingerprint, getDefaultSyncKey } from "./sync-crypto";
import { useLicenseStore } from "../license.service";
import { persistPresence } from "./cloud-sync.store";
import { saveTokens, loadTokens, clearTokens, saveEtag, loadEtag } from "./token-storage";
import { getProvider } from "./providers";
import { isOAuthError } from "./oauth-error";import { useCloudSyncStore } from "./cloud-sync.store";
import type {
  CloudProviderId,
  CloudSnapshot,
  OAuthTokens,
  SyncManifest,
} from "./types";
import { SYNC_FILE_NAME } from "./types";

const PUSH_DEBOUNCE_MS = 3000;
const PULL_INTERVAL_MS = 5 * 60 * 1000;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let bc: BroadcastChannel | null = null;
let isLeader = false;
let unsubscribeAppStore: (() => void) | null = null;
let apiTesterWatcher: ReturnType<typeof setInterval> | null = null;
let initialized = false;

/** Unique id for this browser profile (stable across sessions). */
export function getDeviceId(): string {
  const KEY = "intab_sync_device_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Human-friendly device label (first sync shows "Device ab12cd34"). */
export function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  let os = "Device";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS/i.test(ua)) os = "Mac";
  else if (/Linux/i.test(ua)) os = "Linux";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad/i.test(ua)) os = "iOS";
  const browser = /Edg\//i.test(ua) ? "Edge" : /Chrome/i.test(ua) ? "Chrome" : /Firefox/i.test(ua) ? "Firefox" : /Safari/i.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}`;
}

// ── Multi-tab leader election ────────────────────────────────

const LEADER_CHANNEL = "intab-cloud-sync";

interface BcMessage {
  type: "hello" | "claim" | "leader" | "sync-now";
  from: string;
}

function ensureChannel(): void {
  if (bc || typeof BroadcastChannel === "undefined") return;
  bc = new BroadcastChannel(LEADER_CHANNEL);
  bc.onmessage = (event: MessageEvent<BcMessage>) => {
    const msg = event.data;
    if (!msg || msg.from === getDeviceId()) return; // same tab (paranoia)

    switch (msg.type) {
      case "hello":
        // A new tab joined. The incumbent leader answers so the newcomer stays follower.
        if (isLeader) bc!.postMessage({ type: "leader", from: getDeviceId() } as BcMessage);
        break;
      case "claim":
        // Another tab wants leadership; yield if we're leader.
        if (isLeader) {
          isLeader = false;
          useCloudSyncStore.getState().setMultiTabRole("follower");
        }
        break;
      case "leader":
        if (!isLeader) useCloudSyncStore.getState().setMultiTabRole("follower");
        break;
      case "sync-now":
        // Leader change or explicit request: trigger a pull soon.
        schedulePull(1500);
        break;
    }
  };
}

function claimLeadership(): void {
  ensureChannel();
  if (!bc) {
    // No BroadcastChannel support (old browsers): act as leader.
    isLeader = true;
    useCloudSyncStore.getState().setMultiTabRole("leader");
    return;
  }
  bc.postMessage({ type: "claim", from: getDeviceId() } as BcMessage);
  // Wait briefly for objections; if none, assume leadership.
  let objected = false;
  const onObjection = (event: MessageEvent<BcMessage>) => {
    if (event.data?.type === "leader") objected = true;
  };
  bc.addEventListener("message", onObjection);
  setTimeout(() => {
    bc!.removeEventListener("message", onObjection);
    if (!objected) {
      isLeader = true;
      useCloudSyncStore.getState().setMultiTabRole("leader");
      bc!.postMessage({ type: "leader", from: getDeviceId() } as BcMessage);
      schedulePull(500);
    }
  }, 250);
}

// ── Snapshot collection & application ───────────────────────/** Captures the current local state of all persistence stacks. */
async function collectLocalSnapshot(): Promise<{
  appState: unknown;
  apiTester: unknown;
  chat: unknown;
}> {
  // Dynamic imports keep the cloud-sync module out of the critical path
  const [{ useAppStore }, { selectSyncableAppState }, { getApiTesterSnapshot }, { getChatSnapshot }] = await Promise.all([
    import("@/stores/app.store"),
    import("@/stores/app-store.sync"),
    import("@/stores/api-tester.snapshot"),
    import("@/stores/chat.snapshot"),
  ]);

  const appState = selectSyncableAppState(useAppStore.getState() as unknown as Record<string, unknown>);
  const apiTester = await getApiTesterSnapshot();
  const chat = await getChatSnapshot();

  return { appState, apiTester, chat };
}

/** Applies a remote snapshot onto the local stores. */
async function applyRemoteSnapshot(snapshot: CloudSnapshot): Promise<void> {
  const [{ useAppStore }, { applySyncableAppState }, { applyApiTesterSnapshot }, { applyChatSnapshot }] = await Promise.all([
    import("@/stores/app.store"),
    import("@/stores/app-store.sync"),
    import("@/stores/api-tester.snapshot"),
    import("@/stores/chat.snapshot"),
  ]);

  if (snapshot.appState !== undefined && snapshot.appState !== null) {
    applySyncableAppState(useAppStore, snapshot.appState);
  }
  if (snapshot.apiTester !== undefined && snapshot.apiTester !== null) {
    await applyApiTesterSnapshot(snapshot.apiTester);
  }
  if (snapshot.chat !== undefined && snapshot.chat !== null) {
    await applyChatSnapshot(snapshot.chat);
  }
}

// ── Local-change signature (avoids redundant uploads) ──────

let lastLocalSignature: string | null = null;

function computeLocalSignature(): string {
  const keys = [
    "intab-app-state",
    "intab_chat_state",
    "intab_api_tabs",
    "intab_api_history",
    "intab_api_collections",
    "intab_api_env_vars",
    "intab_api_environments",
    "intab_api_active_env",
    "intab_api_custom_presets",
    "intab_api_added_preset_ids",
    "intab_api_custom_proxy",
  ];
  let hash = 0;
  for (const key of keys) {
    const value = localStorage.getItem(key) || "";
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    hash = (hash * 31 + key.length) | 0;
  }
  return String(hash);
}

// ── Push ────────────────────────────────────────────────────

export function schedulePush(immediate = false): void {
  if (!useCloudSyncStore.getState().isConnected) return;
  if (!isLeader) return;

  // Background polling calls pass immediate=false; skip when nothing changed.
  if (!immediate) {
    const signature = computeLocalSignature();
    if (signature === lastLocalSignature) return;
    lastLocalSignature = signature;
  }

  if (pushTimer) clearTimeout(pushTimer);
  const delay = immediate ? 0 : PUSH_DEBOUNCE_MS;
  pushTimer = setTimeout(() => {
    void pushSnapshot();
  }, delay);
}

async function pushSnapshot(): Promise<void> {
  const store = useCloudSyncStore.getState();
  if (!store.isConnected || !store.tokens) return;
  const providerId = store.provider;
  if (!providerId) return;

  const provider = getProvider(providerId);
  const setStatus = useCloudSyncStore.setState;

  setStatus({ status: "syncing", error: null });

  try {
    const tokens = await ensureFreshTokens(store.tokens);
    const snapshotData = await collectLocalSnapshot();

    const manifest: SyncManifest = {
      updatedAt: new Date().toISOString(),
      deviceId: getDeviceLabel(),
      provider: providerId,
      rev: (loadCachedManifest()?.rev ?? 0) + 1,
      tombstones: [],
      v: 1,
    };

    const payload: CloudSnapshot = {
      manifest,
      appState: snapshotData.appState,
      apiTester: snapshotData.apiTester,
      chat: snapshotData.chat,
    };

    // Always encrypt at rest: license key → true E2E; otherwise pepper+account key.
    const syncKey = resolveSyncKey(store);
    const encrypted = await encryptSnapshotTagged(payload, syncKey);

    const etag = loadEtag(providerId);
    const result = await provider.writeFile(tokens, SYNC_FILE_NAME, encrypted, etag);
    saveEtag(providerId, result.etag);
    saveCachedManifest(manifest);

    setStatus({
      status: "synced",
      lastSyncedAt: Date.now(),
      lastError: null,
    });
  } catch (err) {
    if (isOAuthError(err) && err.code === "token_expired") {
      // Refresh failed elsewhere; mark error for UI
      setStatus({ status: "error", lastError: "Session expired — reconnect your account" });
      return;
    }
    if (!navigator.onLine) {
      setStatus({ status: "offline" });
      return;
    }
    setStatus({
      status: "error",
      lastError: err instanceof Error ? err.message : "Sync failed",
    });
  }
}

// ── Pull ────────────────────────────────────────────────────

export function schedulePull(delayMs = 0): void {
  if (!useCloudSyncStore.getState().isConnected) return;
  setTimeout(() => {
    void pullSnapshot();
  }, delayMs);
}

async function pullSnapshot(): Promise<void> {
  const store = useCloudSyncStore.getState();
  if (!store.isConnected || !store.tokens) return;
  if (!isLeader) return;
  const providerId = store.provider;
  if (!providerId) return;

  const provider = getProvider(providerId);
  const setStatus = useCloudSyncStore.setState;

  try {
    setStatus({ status: "syncing" });
    const tokens = await ensureFreshTokens(store.tokens);

    const remoteRaw = await provider.readFile(tokens, SYNC_FILE_NAME);
    if (!remoteRaw) {
      // Nothing in the cloud yet — seed it with local data.
      await pushSnapshot();
      return;
    }

    // Snapshots are always encrypted and tagged with a non-secret key id.
    // Legacy fallback: older builds stored a bare CipherEnvelope or raw JSON.
    const syncKey = resolveSyncKey(store);
    const remote = await decryptSnapshotFlexible<CloudSnapshot>(remoteRaw, syncKey);
    const cached = loadCachedManifest();

    if (!cached || new Date(remote.manifest.updatedAt) > new Date(cached.updatedAt)) {
      // Remote is newer: apply it locally.
      await applyRemoteSnapshot(remote);
      saveCachedManifest(remote.manifest);
      setStatus({ status: "synced", lastSyncedAt: Date.now(), lastError: null });
    } else {
      setStatus({ status: "synced" });
    }
  } catch (err) {
    if (!navigator.onLine) {
      setStatus({ status: "offline" });
      return;
    }
    setStatus({
      status: "error",
      lastError: err instanceof Error ? err.message : "Sync failed",
    });
  }
}

// ── Key resolution & live rekey ────────────────────────────

/**
 * Picks the active sync key: a valid license key (true E2E) when present,
 * otherwise the default pepper+account at-rest key. Single source of truth
 * so push, pull, and rekey can never disagree about which key is active.
 */
function resolveSyncKey(store: { licenseKey: string | null; tokens: OAuthTokens | null }): string {
  return store.licenseKey ?? getDefaultSyncKey(store.tokens?.accountId || "anonymous");
}

/**
 * Decrypts tagged envelopes (current), bare CipherEnvelopes (legacy), and
 * passes through raw CloudSnapshot JSON (legacy plaintext) transparently.
 */
async function decryptSnapshotFlexible<T>(raw: string, syncKey: string): Promise<T> {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") && raw.includes('"kid"') && raw.includes('"envelope"')) {
    return decryptSnapshotTagged<T>(raw, syncKey);
  }
  if (trimmed.startsWith("{") && raw.includes('"ct"') && raw.includes('"iv"')) {
    return decryptSnapshot<T>(raw, syncKey);
  }
  return JSON.parse(raw) as T;
}

/**
 * Live rekey after license activation/removal while connected: swap the
 * cloud store's key linkage, re-encrypt the remote snapshot under the new
 * key, and warm the derived key cache. Local data is untouched.
 */
export async function rekeyAfterLicenseChange(): Promise<void> {
  const store = useCloudSyncStore.getState();
  if (!store.isConnected || !store.tokens) return;
  const providerId = store.provider;
  if (!providerId) return;

  const license = useLicenseStore.getState();
  const newLicenseKey = license.licenseKey && license.isValid ? license.licenseKey : null;
  const fp = newLicenseKey ? await licenseFingerprint(newLicenseKey) : null;

  // Update engine-visible key + warm the crypto cache for it
  clearSyncCryptoKey();
  useCloudSyncStore.setState({ licenseKey: newLicenseKey, licenseFp: fp });
  await getSyncCryptoKey(resolveSyncKey(useCloudSyncStore.getState()));

  // Re-encrypt the remote snapshot under the new key so pulls on this or
  // another device keep working with the same license/default key.
  try {
    const tokens = await ensureFreshTokens(useCloudSyncStore.getState().tokens!);
    const remoteRaw = await getProvider(providerId).readFile(tokens, SYNC_FILE_NAME);
    if (remoteRaw) {
      const oldKey = newLicenseKey ? getDefaultSyncKey(store.tokens.accountId) : resolveSyncKey(useCloudSyncStore.getState());
      // Try the most plausible previous key first: the one now inactive.
      let snapshot: CloudSnapshot;
      try {
        snapshot = await decryptSnapshotFlexible<CloudSnapshot>(remoteRaw, oldKey);
      } catch {
        snapshot = await decryptSnapshotFlexible<CloudSnapshot>(remoteRaw, newLicenseKey ?? getDefaultSyncKey(store.tokens.accountId));
      }
      const reEncrypted = await encryptSnapshotTagged(snapshot, resolveSyncKey(useCloudSyncStore.getState()));
      const result = await getProvider(providerId).writeFile(tokens, SYNC_FILE_NAME, reEncrypted, loadEtag(providerId));
      saveEtag(providerId, result.etag);
    }
    useCloudSyncStore.setState({ status: "synced", lastError: null });
  } catch (err) {
    useCloudSyncStore.setState({
      status: "error",
      lastError: err instanceof Error ? err.message : "Re-encryption after key change failed",
    });
  }
}

// ── Token freshness ─────────────────────────────────────────

async function ensureFreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  const store = useCloudSyncStore.getState();
  const providerId = store.provider;
  if (!providerId) return tokens;
  const provider = getProvider(providerId);

  // Proactive refresh when within 5 minutes of expiry
  if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
    const refreshed = await provider.refresh(tokens);
    await saveTokens(providerId, refreshed, store.licenseFp ?? undefined);
    useCloudSyncStore.setState({ tokens: refreshed });
    return refreshed;
  }
  return tokens;
}

// ── Manifest cache ──────────────────────────────────────────

function loadCachedManifest(): SyncManifest | null {
  try {
    const raw = localStorage.getItem("intab_cloud_manifest_cache");
    return raw ? (JSON.parse(raw) as SyncManifest) : null;
  } catch {
    return null;
  }
}

function saveCachedManifest(manifest: SyncManifest): void {
  try {
    localStorage.setItem("intab_cloud_manifest_cache", JSON.stringify(manifest));
  } catch {
    /* non-critical */
  }
}

// ── Connection lifecycle ────────────────────────────────────

/**
 * Silent reconnection at app boot: loads vault-encrypted tokens and,
 * when a connection presence exists, resumes sync loops.
 * Never throws — failures surface as status="error" in the store.
 */
export async function restoreOnBoot(): Promise<void> {
  const store = useCloudSyncStore.getState();
  store.hydratePresence();

  const { provider } = useCloudSyncStore.getState();
  const license = useLicenseStore.getState();

  // Seed the cloud store's optional E2E key linkage from the premium store
  if (license.licenseKey && license.isValid) {
    const fp = await licenseFingerprint(license.licenseKey);
    useCloudSyncStore.setState({ licenseKey: license.licenseKey, licenseFp: fp });
  }

  if (!provider) return;

  try {
    const tokens = await loadTokens(provider);
    if (!tokens) {
      // Tokens gone (cleared) — drop connection presence.
      await disconnectProvider(false);
      return;
    }

    // Refresh proactively if expired while away
    const fresh =
      Date.now() > tokens.expiresAt - 60_000
        ? await getProvider(provider).refresh(tokens)
        : tokens;
    if (fresh !== tokens) {
      await saveTokens(provider, fresh, license.licenseKey ?? undefined);
    }

    useCloudSyncStore.setState({
      provider,
      tokens: fresh,
      isConnected: true,
      status: "syncing",
    });
    persistPresence({ provider, isConnected: true, syncSchedule: store.syncSchedule });

    claimLeadership();
    startLoops();
    schedulePull(1500);
  } catch (err) {
    useCloudSyncStore.setState({
      isConnected: false,
      status: "error",
      lastError: err instanceof Error ? err.message : "Reconnection failed",
    });
  }
}

/** Connects a provider with fresh OAuth tokens and starts sync loops. */
export async function connectProvider(providerId: CloudProviderId, tokens: OAuthTokens): Promise<void> {
  const license = useLicenseStore.getState();

  // E2E upgrade: a valid license derives the sync key; otherwise the default
  // pepper+account key encrypts snapshots at rest.
  const licenseKey = license.licenseKey && license.isValid ? license.licenseKey : null;
  const fp = licenseKey ? await licenseFingerprint(licenseKey) : null;
  useCloudSyncStore.setState({ licenseKey, licenseFp: fp });

  await saveTokens(providerId, tokens, licenseKey ?? undefined);
  clearSyncCryptoKey();
  await getSyncCryptoKey(licenseKey ?? getDefaultSyncKey(tokens.accountId));

  useCloudSyncStore.setState({
    provider: providerId,
    tokens,
    isConnected: true,
    status: "syncing",
    error: null,
    lastError: null,
  });
  persistPresence({ provider: providerId, isConnected: true, syncSchedule: useCloudSyncStore.getState().syncSchedule });

  claimLeadership();
  startLoops();

  // Initial pull (or seed push when the cloud file doesn't exist yet)
  schedulePull(300);
}

/** Disconnects and cleans up (optionally removing the cloud file). */
export async function disconnectProvider(removeCloudCopy: boolean): Promise<void> {
  const store = useCloudSyncStore.getState();
  if (store.provider) {
    try {
      const provider = getProvider(store.provider);
      if (store.tokens && removeCloudCopy) {
        await provider.deleteFile(store.tokens, SYNC_FILE_NAME).catch(() => undefined);
        await provider.signOut(store.tokens).catch(() => undefined);
      }
    } catch {
      /* best effort */
    }
    clearTokens(store.provider);
    saveEtag(store.provider, null);
  }

  stopLoops();
  clearSyncCryptoKey();
  try {
    localStorage.removeItem("intab_cloud_manifest_cache");
  } catch {
    /* noop */
  }

  useCloudSyncStore.setState({
    provider: null,
    tokens: null,
    isConnected: false,
    status: "idle",
    lastSyncedAt: null,
    lastError: null,
  });
  persistPresence({ provider: null, isConnected: false, syncSchedule: useCloudSyncStore.getState().syncSchedule });
}

// ── Store subscriptions & timers ────────────────────────────

function startLoops(): void {
  if (initialized) return;
  initialized = true;

  // 1. App store subscription (whole persisted slice changes on any edit)
  void (async () => {
    const { useAppStore } = await import("@/stores/app.store");
    unsubscribeAppStore = useAppStore.subscribe(() => {
      schedulePush();
    });
  })();

  // 2. API tester persistence is debounced/ad-hoc — poll its storage key
  //    signatures; schedulePush skips when nothing actually changed.
  apiTesterWatcher = setInterval(() => {
    if (document.visibilityState === "visible") schedulePush();
  }, 15_000);

  // 3. Periodic pull
  pullTimer = setInterval(() => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      void pullSnapshot();
    }
  }, PULL_INTERVAL_MS);

  // 4. Visibility / online events
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onOnline);
  window.addEventListener("pagehide", onPageHide);
}

function stopLoops(): void {
  initialized = false;
  if (pushTimer) clearTimeout(pushTimer);
  if (pullTimer) clearInterval(pullTimer);
  if (apiTesterWatcher) clearInterval(apiTesterWatcher);
  unsubscribeAppStore?.();
  unsubscribeAppStore = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("pagehide", onPageHide);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    void pullSnapshot();
  } else {
    // Flush pending push when leaving the page
    if (pushTimer) {
      clearTimeout(pushTimer);
      void pushSnapshot();
    }
  }
}

function onOnline(): void {
  useCloudSyncStore.setState({ status: "syncing" });
  void pullSnapshot();
}

function onPageHide(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    // keepalive-less fire-and-forget; best effort on unload
    void pushSnapshot();
  }
}

/** Manual "Sync now" action. */
export function syncNow(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  lastLocalSignature = null; // force next push
  void (async () => {
    await pushSnapshot();
    await pullSnapshot();
  })();
}

// Re-export for UI convenience
export { useCloudSyncStore, persistPresence } from "./cloud-sync.store";
