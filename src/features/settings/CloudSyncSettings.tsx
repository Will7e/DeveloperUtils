// ============================================================
// Cloud Sync Settings — background backup via user's own drive
// ============================================================
// Settings tab: provider connect → live status. Free for everyone.
// Snapshots are always encrypted before upload (encryption at rest);
// a valid license key upgrades the sync key to true cross-device E2E.

import { useState } from "react";
import {
  CloudOff,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Lock,
} from "lucide-react";
import { useAppStore } from "@/stores/app.store";
import { useCloudSyncStore } from "@/services/cloud-sync/cloud-sync.store";
import { connectProvider, disconnectProvider, syncNow } from "@/services/cloud-sync/sync-engine";
import { getProvider } from "@/services/cloud-sync/providers";
import type { CloudProviderId } from "@/services/cloud-sync/types";
import { cn } from "@/lib/utils";
import { GoogleDriveIcon, OneDriveIcon } from "@/components/ui/provider-icons";

type ConnectTarget = "onedrive" | "googledrive";

const PROVIDER_META: Record<ConnectTarget, { label: string; description: string }> = {
  onedrive: {
    label: "OneDrive",
    description: "Syncs to a hidden app folder in your Microsoft account. No admin consent needed.",
  },
  googledrive: {
    label: "Google Drive",
    description: "Syncs to a hidden app folder in your Google account.",
  },
};

function formatLastSynced(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function CloudSyncSettings() {
  const addToast = useAppStore((s) => s.addToast);

  const {
    isConnected,
    isConnecting,
    provider,
    status,
    lastSyncedAt,
    lastError,
    tokens,
  } = useCloudSyncStore();

  const [connectTarget, setConnectTarget] = useState<ConnectTarget | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<null | { removeCloudCopy: boolean }>(null);

  const handleConnect = async (target: CloudProviderId) => {
    setConnectTarget(target);
    try {
      const providerImpl = getProvider(target);
      const t = await providerImpl.signIn();
      await connectProvider(target, t);
      addToast({
        message: `Connected to ${PROVIDER_META[target].label}. Your data will sync automatically.`,
        type: "success",
      });
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : "Connection failed. Please try again.",
        type: "error",
        duration: 7000,
      });
    } finally {
      setConnectTarget(null);
    }
  };

  const handleDisconnect = async (removeCloudCopy: boolean) => {
    setConfirmDisconnect(null);
    await disconnectProvider(removeCloudCopy);
    addToast({
      message: removeCloudCopy
        ? "Disconnected. Your cloud copy was deleted."
        : "Disconnected. Your local data remains untouched.",
      type: "success",
    });
  };

  return (
    <div className="settings-tab-content">
      {/* Connection status banner */}
      {isConnected && (
        <div className="settings-section">
          <div className="settings-section-title">
            {provider ? PROVIDER_META[provider as ConnectTarget].label : "Cloud"} Sync
          </div>
          <div
            className={cn(
              "settings-sync-status",
              status === "synced" && "is-synced",
              status === "syncing" && "is-syncing",
              status === "error" && "is-error",
              status === "offline" && "is-offline"
            )}
          >
            <div className="settings-sync-status-icon">
              {status === "synced" && <CheckCircle2 size={14} />}
              {status === "syncing" && <Loader2 size={14} className="animate-spin" />}
              {(status === "error" || status === "conflict") && <AlertCircle size={14} />}
              {status === "offline" && <CloudOff size={14} />}
            </div>
            <div className="settings-sync-status-text">
              <div className="settings-sync-status-title">
                {status === "synced" && "All changes synced"}
                {status === "syncing" && "Syncing…"}
                {status === "error" && (lastError || "Sync error")}
                {status === "offline" && "Offline — changes will sync when you reconnect"}
                {status === "idle" && "Ready"}
                {status === "conflict" && "Conflict detected — your data is safe"}
              </div>
              <div className="settings-sync-status-sub">
                {tokens?.accountEmail} · Last synced {formatLastSynced(lastSyncedAt)}
              </div>
            </div>
            <button
              type="button"
              className="settings-sync-now"
              onClick={syncNow}
              title="Sync now"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Encryption note — always on */}
          <div className="settings-sync-encrypt-note">
            <Lock className="h-3 w-3 flex-shrink-0" />
            <span>
              Snapshots are encrypted before they leave this device and stored in the hidden app
              folder on your drive.
            </span>
          </div>

          {/* Disconnect */}
          <div className="settings-row py-3">
            <div className="settings-row-info">
              <label className="settings-label">Disconnect {provider ? PROVIDER_META[provider as ConnectTarget].label : ""}</label>
              <span className="settings-sublabel">Stops background sync. Local data is never deleted.</span>
            </div>
            <div className="settings-control">
              <button
                type="button"
                className="settings-sync-disconnect"
                onClick={() => setConfirmDisconnect({ removeCloudCopy: false })}
              >
                <Trash2 className="h-3.5 w-3.5" /> Disconnect
              </button>
            </div>
          </div>

          {confirmDisconnect && (
            <div className="settings-subform-danger">
              <div className="settings-subform-title">Also delete the synced copy in your drive?</div>
              <div className="settings-subform-actions">
                <button
                  type="button"
                  className="settings-subform-danger-btn"
                  onClick={() => void handleDisconnect(true)}
                >
                  Disconnect &amp; Delete Cloud Copy
                </button>
                <button
                  type="button"
                  className="settings-subform-cancel"
                  onClick={() => void handleDisconnect(false)}
                >
                  Keep Cloud Copy
                </button>
                <button
                  type="button"
                  className="settings-subform-cancel"
                  onClick={() => setConfirmDisconnect(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Provider cards (shown when not connected) */}
      {!isConnected && (
        <div className="settings-section">
          <div className="settings-section-title">Connect a Cloud Drive</div>
          <div className="settings-provider-grid">
            {(Object.keys(PROVIDER_META) as ConnectTarget[]).map((id) => (
              <div key={id} className="settings-provider-card">
                <div className="settings-provider-head">
                  {id === "googledrive" ? <GoogleDriveIcon size={16} brandColor /> : <OneDriveIcon size={16} brandColor />}
                  <span className="settings-provider-name">{PROVIDER_META[id].label}</span>
                </div>
                <p className="settings-provider-desc">{PROVIDER_META[id].description}</p>
                {id === "googledrive" && (
                  <p className="settings-provider-warning">
                    Google may show a one-time &quot;unverified app&quot; notice during sign-in.
                    This is expected for early access — click <strong>Advanced → Go to InTab</strong>.
                    Only InTab&apos;s hidden app folder is accessed.
                  </p>
                )}
                <button
                  type="button"
                  className="settings-provider-connect"
                  onClick={() => void handleConnect(id)}
                  disabled={connectTarget !== null}
                >
                  {connectTarget === id ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
                    </>
                  ) : (
                    <>
                      {id === "googledrive" ? <GoogleDriveIcon size={14} /> : <OneDriveIcon size={14} />} Sign in with {PROVIDER_META[id].label}
                    </>
                  )}
                </button>
              </div>
            ))}
          </div>
          {isConnecting && <div className="settings-sync-connecting">Establishing secure connection…</div>}
        </div>
      )}
    </div>
  );
}
