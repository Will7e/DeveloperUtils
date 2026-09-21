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
//  - Selective: per-domain toggles decide what syncs (store.syncDomains);
//    disabled domains are omitted from pushes and never applied from pulls

import { getSyncCryptoKey, encryptSnapshotTagged, decryptSnapshot, decryptSnapshotTagged, clearSyncCryptoKey, licenseFingerprint, getDefaultSyncKey } from "./sync-crypto";
import { useLicenseStore } from "../license.service";
import { persistPresence } from "./cloud-sync.store";
import { saveTokens, loadTokens, clearTokens, saveEtag, loadEtag } from "./token-storage";
import { getProvider } from "./providers";
import { isOAuthError } from "./oauth-error";
import { useCloudSyncStore } from "./cloud-sync.store";
import { readValue } from "../idb-storage.service";
import { flushEncryptedWrites } from "../encrypted-storage.service";
import type {
  CloudProviderId,
  CloudSnapshot,
  OAuthTokens,
  SyncDomain,
  SyncManifest,
} from "./types";
import { SYNC_FILE_NAME } from "./types";

const PUSH_DEBOUNCE_MS = 3000;
const PULL_INTERVAL_MS = 5 * 60 * 1000;
/** Retry backoff for failed pushes (exponential, capped, jittered). */
const PUSH_RETRY_BASE_MS = 5_000;
const PUSH_RETRY_MAX_MS = 5 * 60 * 1000;
/** How long pushes stay muted after a remote snapshot is applied. */
const ECHO_SUPPRESS_MS = 5_000;
/** Time a newcomer waits for an incumbent leader to identify itself. */
const LEADER_ELECTION_MS = 400;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let bc: BroadcastChannel | null = null;
let isLeader = false;
let unsubscribeAppStore: (() => void) | null = null;
let apiTesterWatcher: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let pushRetryCount = 0;

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
//
// Exactly one tab may sync at a time. Tabs used to be identified by a
// localStorage id shared by the whole browser profile, and the message
// handler dropped anything whose sender matched it — which is every sibling
// tab. So no tab ever saw another, every tab elected itself, and N tabs ran
// competing push/pull loops against the same cloud file.

/** Random id for THIS tab. Deliberately not the per-profile sync device id. */
const TAB_ID = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
})();

const LEADER_CHANNEL = "intab-cloud-sync";
const LEADER_LOCK = "intab-cloud-sync-leader";

interface BcMessage {
  type: "hello" | "leader" | "sync-now";
  from: string;
}

/** Minimal shape of the Web Locks API (absent from some TS lib targets). */
type LockManagerLike = {
  request: (
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<void>
  ) => Promise<unknown>;
};

function lockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

let leadershipRequested = false;
let releaseLease: (() => void) | null = null;
/** Bumped on release so a lease granted after a disconnect is ignored. */
let leadershipGeneration = 0;

function setLeader(leader: boolean): void {
  isLeader = leader;
  useCloudSyncStore.getState().setMultiTabRole(leader ? "leader" : "follower");
  if (leader) schedulePull(500);
}

/**
 * Takes the exclusive leadership lease. Web Locks is the primary mechanism:
 * the browser holds the lock until this tab goes away and then hands it to the
 * next waiter, so a surviving tab takes over automatically and no handshake
 * can leave zero (or two) leaders.
 */
function acquireLeadership(): void {
  if (leadershipRequested) return;
  leadershipRequested = true;
  const generation = leadershipGeneration;
  ensureChannel();

  const locks = lockManager();
  if (locks) {
    // Until the lease is granted this tab is a follower.
    useCloudSyncStore.getState().setMultiTabRole("follower");
    void locks
      .request(LEADER_LOCK, { mode: "exclusive" }, async () => {
        // The lease may have been released (disconnect) while this request was
        // still queued — do not take leadership for a dead connection.
        if (generation !== leadershipGeneration) return;
        setLeader(true);
        await new Promise<void>((resolve) => {
          releaseLease = resolve;
        });
        releaseLease = null;
        setLeader(false);
      })
      .catch((err) => {
        console.warn("Cloud sync leadership lease failed:", err);
        if (generation === leadershipGeneration) leadershipRequested = false;
      });
    return;
  }

  // No Web Locks (older browsers): arbitrate over BroadcastChannel instead.
  claimLeadershipViaChannel();
}

/** Drops the lease so another tab (or a later reconnect) can take over. */
function releaseLeadership(): void {
  const release = releaseLease;
  releaseLease = null;
  leadershipRequested = false;
  leadershipGeneration += 1;
  isLeader = false;
  release?.();
  useCloudSyncStore.getState().setMultiTabRole(null);
}

function ensureChannel(): void {
  if (bc || typeof BroadcastChannel === "undefined") return;
  bc = new BroadcastChannel(LEADER_CHANNEL);
  bc.onmessage = (event: MessageEvent<BcMessage>) => {
    const msg = event.data;
    if (!msg || msg.from === TAB_ID) return; // our own message

    switch (msg.type) {
      case "hello":
        // A new tab joined. If we hold the lease, confirm so it stays follower.
        if (isLeader) bc!.postMessage({ type: "leader", from: TAB_ID } as BcMessage);
        break;
      case "leader":
        // Another tab holds leadership; make sure we are not acting as leader.
        if (isLeader) setLeader(false);
        break;
      case "sync-now":
        schedulePull(1500);
        break;
    }
  };
}

function claimLeadershipViaChannel(): void {
  if (!bc) {
    // No BroadcastChannel support (old browsers): act as leader.
    setLeader(true);
    return;
  }
  let sawLeader = false;
  const onMessage = (event: MessageEvent<BcMessage>) => {
    const msg = event.data;
    if (msg && msg.from !== TAB_ID && msg.type === "leader") sawLeader = true;
  };
  bc.addEventListener("message", onMessage);
  bc.postMessage({ type: "hello", from: TAB_ID } as BcMessage);

  setTimeout(() => {
    bc?.removeEventListener("message", onMessage);
    if (sawLeader) {
      isLeader = false;
      useCloudSyncStore.getState().setMultiTabRole("follower");
      return;
    }
    setLeader(true);
    bc?.postMessage({ type: "leader", from: TAB_ID } as BcMessage);
  }, LEADER_ELECTION_MS);
}

// ── Snapshot collection & application ───────────────────────

/**
 * Captures the current local state of the persistence stacks selected for
 * sync. Domains not selected for sync are omitted from the snapshot.
 */
async function collectLocalSnapshot(): Promise<{
  appState?: unknown;
  apiTester?: unknown;
  chat?: unknown;
}> {
  // Dynamic imports keep the cloud-sync module out of the critical path
  const [{ useAppStore }, { selectSyncableAppState }, { getApiTesterSnapshot }, { getChatSnapshot }] = await Promise.all([
    import("@/stores/app.store"),
    import("@/stores/app-store.sync"),
    import("@/stores/api-tester.snapshot"),
    import("@/stores/chat.snapshot"),
  ]);

  const { syncDomains } = useCloudSyncStore.getState();

  const [appState, apiTester, chat] = await Promise.all([
    syncDomains.appState
      ? Promise.resolve(selectSyncableAppState(useAppStore.getState() as unknown as Record<string, unknown>))
      : Promise.resolve(undefined),
    syncDomains.apiTester ? getApiTesterSnapshot() : Promise.resolve(undefined),
    syncDomains.chat ? getChatSnapshot() : Promise.resolve(undefined),
  ]);

  return { appState, apiTester, chat };
}

// ── Local-change signature (avoids redundant uploads) ──────

const SYNCED_SIG_KEY = "intab_cloud_last_synced_sig";

/** Signature of the local state the cloud is known to hold. */
let lastPushedSignature: string | null = null;
/** Pushes stay muted until this timestamp (see baselineAfterRemoteApply). */
let suppressPushUntil = 0;

function loadSyncedSignature(): string | null {
  try {
    return localStorage.getItem(SYNCED_SIG_KEY);
  } catch {
    return null;
  }
}

/** Records the signature of the state now known to be in the cloud. */
function saveSyncedSignature(signature: string): void {
  lastPushedSignature = signature;
  try {
    localStorage.setItem(SYNCED_SIG_KEY, signature);
  } catch {
    /* non-critical */
  }
}

function clearSyncedSignature(): void {
  lastPushedSignature = null;
  try {
    localStorage.removeItem(SYNCED_SIG_KEY);
  } catch {
    /* non-critical */
  }
}

/**
 * True when local content differs from the last state this device pushed or
 * applied. Pulls use it to publish local work before it can be overwritten.
 */
async function hasUnsyncedLocalChanges(): Promise<boolean> {
  const known = lastPushedSignature ?? loadSyncedSignature();
  // No baseline yet (fresh install, or the very first sync): let the pull
  // decide, so a new device cannot push its default state over an existing
  // cloud copy.
  if (known === null) return false;
  return (await computeLocalSignature()) !== known;
}

/**
 * Hash of the storage keys belonging to the domains currently selected for
 * sync. Keys of disabled domains are excluded so background push polling
 * never schedules uploads for data this device doesn't sync. Toggling a
 * domain therefore changes the signature, which is intentional: the next
 * push uploads the newly enabled domain promptly.
 */
async function computeLocalSignature(): Promise<string> {
  // Zustand writes are coalesced (~60ms), so a signature taken before they
  // land would either miss a real edit or report churn that never lands.
  await flushEncryptedWrites();
  const { syncDomains } = useCloudSyncStore.getState();
  const keys: Array<[key: string, domain: SyncDomain]> = [];
  if (syncDomains.appState) keys.push(["intab-app-state", "appState"]);
  if (syncDomains.chat) keys.push(["intab_chat_state", "chat"]);
  if (syncDomains.apiTester) {
    for (const k of [
      "intab_api_tabs",
      "intab_api_history",
      "intab_api_collections",
      "intab_api_env_vars",
      "intab_api_environments",
      "intab_api_active_env",
      "intab_api_custom_presets",
      "intab_api_added_preset_ids",
      "intab_api_custom_proxy",
    ]) {
      keys.push([k, "apiTester"]);
    }
  }
  let hash = 0;
  for (const [key, domain] of keys) {
    // Heavy keys live in IndexedDB now; readValue spans both stores.
    const value = (await readValue(key)) || "";
    for (let i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    hash = (hash * 31 + key.length) | 0;
    hash = (hash * 31 + domain.length) | 0;
  }
  return String(hash);
}

// ── Push ────────────────────────────────────────────────────

function schedulePushTimer(delay: number): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    // Null the handle as it fires: a stale non-null id used to make every
    // later "a push is already pending" check skip scheduling forever.
    pushTimer = null;
    void pushSnapshot();
  }, delay);
}

/**
 * Retries a failed push with capped exponential backoff + jitter. The change
 * detector only re-arms on detected local changes, so without this a transient
 * failure would stall until the user happened to edit something again.
 */
function schedulePushRetry(): void {
  pushRetryCount += 1;
  const backoff = Math.min(PUSH_RETRY_MAX_MS, PUSH_RETRY_BASE_MS * 2 ** (pushRetryCount - 1));
  schedulePushTimer(backoff + Math.floor(Math.random() * 1_000));
}

export function schedulePush(immediate = false): void {
  const store = useCloudSyncStore.getState();
  if (!store.isConnected) return;
  if (!isLeader) return;

  if (immediate) {
    schedulePushTimer(0);
    return;
  }

  // "Manual" means the background loops stay quiet.
  if (store.syncSchedule === "manual") return;

  // Mute the storage churn caused by applying a remote snapshot, or each
  // device would immediately re-upload what it just received.
  if (Date.now() < suppressPushUntil) return;

  // Background polling calls pass immediate=false; skip when nothing changed.
  // The signature reads IndexedDB (async), so the check continues off the
  // calling stack without blocking store subscribers.
  void computeLocalSignature().then((signature) => {
    if (signature === (lastPushedSignature ?? loadSyncedSignature())) return;
    // Respect an already-pending push (e.g. an immediate one) instead of
    // clearing and re-delaying it.
    if (pushTimer !== null) return;
    schedulePushTimer(PUSH_DEBOUNCE_MS);
  });
}

async function pushSnapshot(options: { allowConflictRecovery?: boolean } = {}): Promise<void> {
  const { allowConflictRecovery = true } = options;
  const store = useCloudSyncStore.getState();
  if (!store.isConnected || !store.tokens) return;
  const providerId = store.provider;
  if (!providerId) return;

  const provider = getProvider(providerId);
  const setStatus = useCloudSyncStore.setState;

  setStatus({ status: "syncing", error: null });

  try {
    // Taken before collecting, so a change made mid-upload is detected again
    // by the next poll instead of being marked as already synced.
    const signature = await computeLocalSignature();
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

    // Only include domains selected for sync; disabled ones stay untouched
    // on other devices too (a missing domain is a no-op on apply, never a
    // deletion — see applyRemoteSnapshot).
    const payload: CloudSnapshot = { manifest };
    if (snapshotData.appState !== undefined) payload.appState = snapshotData.appState;
    if (snapshotData.apiTester !== undefined) payload.apiTester = snapshotData.apiTester;
    if (snapshotData.chat) payload.chat = snapshotData.chat;

    // Always encrypt at rest: license key → true E2E; otherwise pepper+account key.
    const syncKey = resolveSyncKey(store);
    const encrypted = await encryptSnapshotTagged(payload, syncKey);

    const etag = loadEtag(providerId);
    const result = await provider.writeFile(tokens, SYNC_FILE_NAME, encrypted, etag);
    saveEtag(providerId, result.etag);
    saveCachedManifest(manifest);

    // The local state is only known to be in the cloud now, which is why the
    // baseline signature is recorded here and not when the push is scheduled: a
    // failed push used to be forgotten and never retried.
    saveSyncedSignature(signature);
    pushRetryCount = 0;

    setStatus({
      status: "synced",
      lastSyncedAt: Date.now(),
      lastError: null,
    });
  } catch (err) {
    await handlePushFailure(err, providerId, allowConflictRecovery);
  }
}

/** Classifies a push failure and keeps retrying whatever is retryable. */
async function handlePushFailure(
  err: unknown,
  providerId: CloudProviderId,
  allowConflictRecovery: boolean
): Promise<void> {
  const setStatus = useCloudSyncStore.setState;

  if (isOAuthError(err) && err.code === "conflict") {
    if (allowConflictRecovery) {
      await recoverFromConflict(providerId);
      return;
    }
    setStatus({ status: "conflict", lastError: "Remote copy changed at the same time" });
    schedulePushRetry();
    return;
  }

  if (isOAuthError(err) && (err.code === "token_expired" || err.code === "no_refresh_token")) {
    // Refreshing failed: only the user reconnecting can fix this.
    setStatus({ status: "error", lastError: "Session expired — reconnect your account" });
    return;
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    setStatus({ status: "offline" });
    schedulePushRetry();
    return;
  }

  setStatus({
    status: "error",
    lastError: err instanceof Error ? err.message : "Sync failed",
  });
  // Transient failures (5xx, rate limits, dropped connections) are retried with
  // backoff instead of waiting for the next local edit.
  schedulePushRetry();
}

/**
 * A 409/412 means another device wrote between our read and our write. Read the
 * remote copy (which also refreshes the etag we would otherwise still be
 * missing), keep the newer side, then retry our push once.
 */
async function recoverFromConflict(providerId: CloudProviderId): Promise<void> {
  const setStatus = useCloudSyncStore.setState;
  setStatus({ status: "conflict", lastError: "Remote copy changed — re-syncing" });
  try {
    const remote = await readRemoteSnapshot(providerId);
    if (remote.snapshot) {
      if (isRemoteNewer(remote.snapshot.manifest, loadCachedManifest())) {
        await applyRemoteSnapshot(remote.snapshot);
        saveCachedManifest(remote.snapshot.manifest);
        await baselineAfterRemoteApply();
      }
    }
    // Retry our own upload on top of the revision we just read.
    await pushSnapshot({ allowConflictRecovery: false });
  } catch (err) {
    setStatus({
      status: "error",
      lastError: err instanceof Error ? err.message : "Could not resolve the sync conflict",
    });
    schedulePushRetry();
  }
}

/**
 * Reads and decrypts the cloud snapshot, refreshing the cached etag.
 * Keeping the etag in step with the content we just read is what stops the
 * next push from conflicting after any remote change.
 */
async function readRemoteSnapshot(
  providerId: CloudProviderId
): Promise<{ snapshot: CloudSnapshot | null; etag: string | null }> {
  const store = useCloudSyncStore.getState();
  if (!store.tokens) return { snapshot: null, etag: null };
  const provider = getProvider(providerId);
  const tokens = await ensureFreshTokens(store.tokens);
  const read = await provider.readFile(tokens, SYNC_FILE_NAME);
  saveEtag(providerId, read.etag);
  if (!read.content) return { snapshot: null, etag: read.etag };
  const syncKey = resolveSyncKey(useCloudSyncStore.getState());
  const snapshot = await decryptSnapshotFlexible<CloudSnapshot>(read.content, syncKey);
  return { snapshot, etag: read.etag };
}

/**
 * Applies a remote snapshot onto the local stores, skipping domains that
 * are not selected for sync on this device (their local data stays intact).
 * A missing/null remote domain is a no-op — it means the producing device does
 * not sync that domain, never that the data was deleted.
 */
async function applyRemoteSnapshot(snapshot: CloudSnapshot): Promise<void> {
  const [{ useAppStore }, { applySyncableAppState }, { applyApiTesterSnapshot }, { applyChatSnapshot }] = await Promise.all([
    import("@/stores/app.store"),
    import("@/stores/app-store.sync"),
    import("@/stores/api-tester.snapshot"),
    import("@/stores/chat.snapshot"),
  ]);

  const { syncDomains } = useCloudSyncStore.getState();

  if (syncDomains.appState && snapshot.appState != null) {
    applySyncableAppState(useAppStore, snapshot.appState);
  }
  if (syncDomains.apiTester && snapshot.apiTester != null) {
    await applyApiTesterSnapshot(snapshot.apiTester);
  }
  if (syncDomains.chat && snapshot.chat != null) {
    await applyChatSnapshot(snapshot.chat);
  }
}

/**
 * Records the post-apply signature as the synced baseline and briefly mutes
 * pushes. Applying a snapshot rewrites local storage (fresh IVs → new
 * ciphertext), which would otherwise look like a local edit and push the same
 * snapshot straight back — the A→B→A echo loop.
 */
async function baselineAfterRemoteApply(): Promise<void> {
  suppressPushUntil = Date.now() + ECHO_SUPPRESS_MS;
  saveSyncedSignature(await computeLocalSignature());
}

/**
 * Ordering: revisions are Lamport-style (every push continues the highest
 * revision the device has seen), so they are the primary signal and the
 * wall-clock timestamp is only a tie-breaker. Comparing timestamps alone meant
 * clock skew or a restored backup could make an older snapshot win over a
 * newer one.
 */
function isRemoteNewer(remote: SyncManifest, cached: SyncManifest | null): boolean {
  if (!cached) return true;
  const remoteRev = Number.isFinite(remote.rev) ? remote.rev : 0;
  const cachedRev = Number.isFinite(cached.rev) ? cached.rev : 0;
  if (remoteRev !== cachedRev) return remoteRev > cachedRev;
  const remoteAt = new Date(remote.updatedAt).getTime();
  const cachedAt = new Date(cached.updatedAt).getTime();
  return remoteAt > cachedAt;
}

// ── Pull ────────────────────────────────────────────────────

export function schedulePull(delayMs = 0): void {
  if (!useCloudSyncStore.getState().isConnected) return;
  setTimeout(() => {
    void pullSnapshot();
  }, delayMs);
}

let pullPromise: Promise<void> | null = null;

/**
 * Single-flight pull: the interval, visibility and online triggers can all fire
 * close together, and overlapping pulls used to apply snapshots concurrently.
 */
function pullSnapshot(): Promise<void> {
  if (pullPromise) return pullPromise;
  pullPromise = runPull().finally(() => {
    pullPromise = null;
  });
  return pullPromise;
}

async function runPull(): Promise<void> {
  const store = useCloudSyncStore.getState();
  if (!store.isConnected || !store.tokens) return;
  if (!isLeader) return;
  const providerId = store.provider;
  if (!providerId) return;

  const provider = getProvider(providerId);
  const setStatus = useCloudSyncStore.setState;

  try {
    setStatus({ status: "syncing" });

    // Publish local work BEFORE reading the remote copy: a pull may not
    // silently discard edits this device has not uploaded yet.
    if (await hasUnsyncedLocalChanges()) {
      await pushSnapshot();
      if (!useCloudSyncStore.getState().isConnected) return;
    }

    const current = useCloudSyncStore.getState();
    if (!current.tokens) return;
    const tokens = await ensureFreshTokens(current.tokens);

    const read = await provider.readFile(tokens, SYNC_FILE_NAME);
    // Refresh the optimistic-concurrency token with the content we just read,
    // otherwise the next push is guaranteed to conflict after any remote write.
    saveEtag(providerId, read.etag);

    if (!read.content) {
      // Nothing in the cloud yet — seed it with local data.
      await pushSnapshot();
      return;
    }

    // Snapshots are always encrypted and tagged with a non-secret key id.
    // Legacy fallback: older builds stored a bare CipherEnvelope or raw JSON.
    const syncKey = resolveSyncKey(useCloudSyncStore.getState());
    const remote = await decryptSnapshotFlexible<CloudSnapshot>(read.content, syncKey);
    const cached = loadCachedManifest();

    if (isRemoteNewer(remote.manifest, cached)) {
      // Remote is newer: apply it locally, then re-baseline so the apply itself
      // is not mistaken for a local edit and echoed back to the cloud.
      await applyRemoteSnapshot(remote);
      saveCachedManifest(remote.manifest);
      await baselineAfterRemoteApply();
      setStatus({ status: "synced", lastSyncedAt: Date.now(), lastError: null });
    } else {
      setStatus({ status: "synced" });
    }
  } catch (err) {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
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
  // Route by shape after a single parse: a tagged envelope (current), a bare
  // CipherEnvelope (legacy), or plain JSON (legacy plaintext). Substring
  // sniffing could misroute any legacy payload that merely contained the words.
  const parsed = JSON.parse(raw) as Record<string, unknown> | null;
  if (parsed && typeof parsed === "object") {
    if ("envelope" in parsed && "kid" in parsed) {
      return decryptSnapshotTagged<T>(raw, syncKey);
    }
    if (typeof parsed.ct === "string" && typeof parsed.iv === "string") {
      return decryptSnapshot<T>(raw, syncKey);
    }
  }
  return parsed as T;
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
    const tokens = await ensureFreshTokens(useCloudSyncStore.getState().tokens ?? store.tokens);
    const provider = getProvider(providerId);
    const read = await provider.readFile(tokens, SYNC_FILE_NAME);
    if (read.content) {
      // The key that was active BEFORE this change. `store` was captured before
      // the store update above, so store.licenseKey still holds the old license
      // key. Deriving the old key from post-update state (as this used to) meant
      // removing a license could not read the file it was about to re-encrypt,
      // leaving the cloud copy sealed under a key the engine no longer had —
      // every later pull then failed with a "different key" error.
      const previousKey = store.licenseKey ?? getDefaultSyncKey(store.tokens.accountId);
      let snapshot: CloudSnapshot;
      try {
        snapshot = await decryptSnapshotFlexible<CloudSnapshot>(read.content, previousKey);
      } catch {
        snapshot = await decryptSnapshotFlexible<CloudSnapshot>(
          read.content,
          newLicenseKey ?? getDefaultSyncKey(store.tokens.accountId)
        );
      }
      const reEncrypted = await encryptSnapshotTagged(snapshot, resolveSyncKey(useCloudSyncStore.getState()));
      const result = await provider.writeFile(
        tokens,
        SYNC_FILE_NAME,
        reEncrypted,
        read.etag ?? loadEtag(providerId)
      );
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
  let licenseFp: string | null = null;
  if (license.licenseKey && license.isValid) {
    licenseFp = await licenseFingerprint(license.licenseKey);
    useCloudSyncStore.setState({ licenseKey: license.licenseKey, licenseFp });
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
      // `licenseFp` is a fingerprint everywhere else in the token payload; the
      // raw license key used to be written into that field on this path.
      await saveTokens(provider, fresh, licenseFp ?? undefined);
    }

    useCloudSyncStore.setState({
      provider,
      tokens: fresh,
      isConnected: true,
      status: "syncing",
    });
    persistPresence({
      provider,
      isConnected: true,
      syncSchedule: store.syncSchedule,
      syncDomains: store.syncDomains,
    });

    acquireLeadership();
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

  await saveTokens(providerId, tokens, fp ?? undefined);
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
  persistPresence({
    provider: providerId,
    isConnected: true,
    syncSchedule: useCloudSyncStore.getState().syncSchedule,
    syncDomains: useCloudSyncStore.getState().syncDomains,
  });

  acquireLeadership();
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
  releaseLeadership();
  clearSyncCryptoKey();
  // Without dropping these, a later reconnect would compare against the previous
  // connection's baseline and staleness bookkeeping would be wrong.
  clearSyncedSignature();
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
  persistPresence({
    provider: null,
    isConnected: false,
    syncSchedule: useCloudSyncStore.getState().syncSchedule,
    syncDomains: useCloudSyncStore.getState().syncDomains,
  });
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
    if (useCloudSyncStore.getState().syncSchedule === "manual") return;
    if (document.visibilityState === "visible") schedulePush();
  }, 15_000);

  // 3. Periodic pull (skipped entirely in "manual" mode, which syncs only on
  //    connect/boot and on an explicit "Sync now")
  pullTimer = setInterval(() => {
    if (useCloudSyncStore.getState().syncSchedule === "manual") return;
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
  pushTimer = null;
  if (pullTimer) clearInterval(pullTimer);
  pullTimer = null;
  if (apiTesterWatcher) clearInterval(apiTesterWatcher);
  apiTesterWatcher = null;
  pushRetryCount = 0;
  unsubscribeAppStore?.();
  unsubscribeAppStore = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("pagehide", onPageHide);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    if (useCloudSyncStore.getState().syncSchedule === "manual") return;
    void pullSnapshot();
    return;
  }
  // Flush a pending push when leaving the page. Nulling the handle matters:
  // a stale non-null id made every later "already pending" check skip.
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
    void pushSnapshot();
  }
}

function onOnline(): void {
  useCloudSyncStore.setState({ status: "syncing" });
  void pullSnapshot();
}

function onPageHide(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
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
  pushRetryCount = 0; // an explicit retry should not inherit a long backoff
  void (async () => {
    await pushSnapshot();
    await pullSnapshot();
  })();
}

// Re-export for UI convenience
export { useCloudSyncStore, persistPresence } from "./cloud-sync.store";
