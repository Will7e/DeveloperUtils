// ============================================================
// Workspace Readouts — One Read Each, For Every Surface
// ============================================================
// The container host and the preview bridge are module-level stores with no
// re-render of their own, so every surface that shows them has to subscribe the
// same way — with `useSyncExternalStore` over a monotonic revision, not with an
// effect that copies state into React. An effect-shaped copy is the version that
// goes stale in exactly the window that matters: a boot that finishes while the
// user is looking at the strip would render the previous state until something
// unrelated re-rendered the tree.
//
// Two hooks rather than one, because the two stores change at completely
// different rates: the workspace boots once and then sits still, while the
// preview's console fills as the app runs. A single subscription would re-render
// the status line on every console message.

import React from "react";
import {
  containerRevision,
  containerStatus,
  subscribeContainer,
  type ContainerStatus,
} from "../container/container-host";
import {
  previewRevision,
  previewState,
  subscribePreview,
  type PreviewState,
} from "../container/preview-bridge";
import { workspaceSupport } from "../lib/availability";
import type { CapabilityState } from "../lib/availability";

export function useContainerStatus(): ContainerStatus {
  return React.useSyncExternalStore(subscribeContainer, containerStatus, containerStatus);
}

export function usePreview(): PreviewState {
  return React.useSyncExternalStore(subscribePreview, previewState, previewState);
}

/** The revision counters, for a caller that needs them as memo keys */
export function useContainerRevision(): number {
  return React.useSyncExternalStore(subscribeContainer, containerRevision, containerRevision);
}

export function usePreviewRevision(): number {
  return React.useSyncExternalStore(subscribePreview, previewRevision, previewRevision);
}

/**
 * Whether this page can run commands at all, re-read as the answer changes.
 *
 * The page's own verdict is declared (isolation headers) while the observed state
 * comes from a boot, so a page that becomes usable mid-session — a failed boot
 * retried, a runtime that came up after a slow start — has to be able to say so.
 * Reading the capability map version is what makes that transition render.
 */
export function useWorkspaceCapability(): { state: CapabilityState; reason: string | null } {
  // Subscribed, not memoised: every transition that can change this answer — a
  // boot that succeeded, a boot that failed — is recorded by the host, and the
  // host's revision is what re-renders the surfaces that read it.
  useContainerRevision();
  return workspaceSupport();
}
