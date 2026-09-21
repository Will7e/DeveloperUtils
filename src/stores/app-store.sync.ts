// ============================================================
// App Store — Cloud Sync Bridge
// ============================================================
// Selects the persisted (syncable) slice of the app store and
// applies remote snapshots. Mirrors the store's `partialize`
// configuration; keep both lists in sync when adding fields.

/**
 * Extracts the persisted, syncable slice from the app store state.
 * Must list exactly the keys persisted in `partialize` (app.store.ts).
 */
export function selectSyncableAppState(
  state: Record<string, unknown>
): Record<string, unknown> {
  const {
    files,
    activeFileId,
    sidebarCollapsed,
    outputPanelOpen,
    editorSettings,
    tabExec,
    formatterFiles,
    activeFormatterFileId,
    formatterType,
    comparatorSessions,
    activeComparatorSessionId,
    comparatorSettings,
    diffSessions,
    activeDiffSessionId,
    diffSettings,
    librarySelectedItemId,
    librarySearchQuery,
    libraryDrawFlowCategory,
    libraryExcalidrawCategory,
    workflows,
    activeWorkflowId,
    drawflowLibraryItems,
    drawflowAddedLibraryIds,
    excalidrawLibraryItems,
    excalidrawAddedLibraryIds,
  } = state;

  return {
    files,
    activeFileId,
    sidebarCollapsed,
    outputPanelOpen,
    editorSettings,
    tabExec,
    formatterFiles,
    activeFormatterFileId,
    formatterType,
    comparatorSessions,
    activeComparatorSessionId,
    comparatorSettings,
    diffSessions,
    activeDiffSessionId,
    diffSettings,
    librarySelectedItemId,
    librarySearchQuery,
    libraryDrawFlowCategory,
    libraryExcalidrawCategory,
    workflows,
    activeWorkflowId,
    drawflowLibraryItems,
    drawflowAddedLibraryIds,
    excalidrawLibraryItems,
    excalidrawAddedLibraryIds,
  };
}

/**
 * Applies a remote app-state snapshot onto the local store.
 * Uses `persist.setState` when available so the change flows through
 * the persist middleware (re-encrypts + writes localStorage) without
 * wiping action methods (which are never part of the persisted slice).
 */
export function applySyncableAppState(
  store: unknown,
  remotePartial: unknown
): void {
  if (!remotePartial || typeof remotePartial !== "object") return;

  const typedStore = store as {
    setState: (partial: Record<string, unknown>) => void;
    getState: () => Record<string, unknown>;
    persist?: { setState?: (partial: Record<string, unknown>) => void };
  };

  const partial = remotePartial as Record<string, unknown>;

  if (typeof typedStore.persist?.setState === "function") {
    typedStore.persist.setState(partial);
  } else {
    typedStore.setState(partial);
  }
}
