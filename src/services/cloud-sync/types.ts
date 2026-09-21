// ============================================================
// Cloud Sync — Shared Types
// ============================================================
// OneDrive / Google Drive background sync for InTab Premium.
// All payloads uploaded to the cloud are encrypted with the
// portable license-derived key (never the device vault key).

export type CloudProviderId = "onedrive" | "googledrive";

/** Data domains the user can individually include in cloud sync. */
export type SyncDomain = "appState" | "apiTester" | "chat";

/** All syncable domains in a stable, display-friendly order. */
export const SYNC_DOMAINS: readonly SyncDomain[] = ["appState", "apiTester", "chat"] as const;

/** OAuth tokens issued via PKCE. Stored encrypted with the device vault. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms when accessToken expires */
  expiresAt: number;
  /** OAuth scopes granted (space-separated) */
  scope: string;
  /** User-visible account identifier (email / UPN) */
  accountEmail: string;
  /** Stable account id to distinguish multiple accounts */
  accountId: string;
  obtainedAt: number;
}

/** Minimal storage contract each cloud provider implements. */
export interface CloudProvider {
  readonly id: CloudProviderId;
  readonly displayName: string;

  /** Build the OAuth authorize URL and open the popup flow. Resolves tokens. */
  signIn(): Promise<OAuthTokens>;

  /** Silently refresh the access token. Throws when refresh is impossible. */
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;

  /** Revoke server-side when possible, then clear local tokens. */
  signOut(tokens: OAuthTokens | null): Promise<void>;

  /**
   * Read a text file from the app folder. `content` is null when the file does
   * not exist yet. `etag` is the revision token the next `writeFile` must send
   * for optimistic concurrency — it has to be refreshed on every read, or the
   * next push is guaranteed to conflict after any change from another device.
   */
  readFile(tokens: OAuthTokens, path: string): Promise<FileReadResult>;

  /**
   * Create or update a text file in the app folder.
   * `etag` enables optimistic concurrency (409 on conflict).
   */
  writeFile(
    tokens: OAuthTokens,
    path: string,
    content: string,
    etag: string | null
  ): Promise<WriteResult>;

  /** Delete a file from the app folder. */
  deleteFile(tokens: OAuthTokens, path: string): Promise<void>;

  /** Best-effort listing of app folder files (for cleanup / diagnostics). */
  listFiles(tokens: OAuthTokens): Promise<{ name: string; etag: string | null }[]>;
}

export interface WriteResult {
  etag: string | null;
}

/** Body + revision token returned by `CloudProvider.readFile`. */
export interface FileReadResult {
  content: string | null;
  etag: string | null;
}

/** Metadata about the last cloud snapshot — the sync "manifest". */
export interface SyncManifest {
  /** ISO timestamp of the snapshot creation */
  updatedAt: string;
  /** Human device label that produced the snapshot */
  deviceId: string;
  /** Provider id that holds the payload */
  provider: CloudProviderId;
  /**
   * Lamport-style revision: every push continues the highest revision it has
   * seen, which makes it the primary ordering signal across devices (the
   * `updatedAt` wall clock is only a tie-breaker, since clocks disagree).
   */
  rev: number;
  /**
   * Reserved for propagating deletions of whole snapshot keys. Currently
   * always empty: a domain missing from a snapshot means the producing device
   * does not sync that domain, NOT that its data was deleted — so appliers must
   * treat absence as a no-op. Domain-level deletions propagate as ordinary
   * content changes instead.
   */
  tombstones: string[];
  /** Schema version of the payload envelope */
  v: 1;
}

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error" | "conflict";

/**
 * The full snapshot envelope stored in the cloud (encrypted).
 * Domain payloads (`appState`, `apiTester`, `chat`) may be absent when that
 * domain is not selected for sync on the device that produced the snapshot —
 * appliers must treat a missing domain as "leave local data untouched".
 */
export interface CloudSnapshot {
  manifest: SyncManifest;
  appState?: unknown;
  apiTester?: unknown;
  /** AI chat conversations + settings (encrypted with the same envelope) */
  chat?: unknown;
}

export const SYNC_FILE_NAME = "intab-sync.json";
