// ============================================================
// Cloud Sync — Provider Registry
// ============================================================

import type { CloudProvider, CloudProviderId } from "../types";
import { oneDriveProvider } from "./onedrive";
import { googleDriveProvider } from "./googledrive";

export const CLOUD_PROVIDERS: Record<CloudProviderId, CloudProvider> = {
  onedrive: oneDriveProvider,
  googledrive: googleDriveProvider,
};

export function getProvider(id: CloudProviderId): CloudProvider {
  return CLOUD_PROVIDERS[id];
}
