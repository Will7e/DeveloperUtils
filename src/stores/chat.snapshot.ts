// ============================================================
// AI Chat — Cloud Sync Snapshot Bridge
// ============================================================
// Collects the persisted chat state (conversations + settings,
// including the OpenRouter key) for the cloud sync engine and
// applies remote snapshots back onto the chat store.
//
// Semantics: whole-collection last-writer-wins, matching the
// app-state bridge. A local guard skips applies while a stream
// is in flight so a remote pull never clobbers live output.
// Payloads are encrypted by the sync engine (license-derived or
// pepper+account key) before leaving the device.

import { createEncryptedStorage } from "@/services/encrypted-storage.service";
import { useChatStore } from "./chat.store";

const CHAT_STORAGE_NAME = "intab_chat_state";

/** Persisted chat slice shape (mirrors the store's `partialize`). */
interface ChatPersistedState {
  conversations: unknown;
  activeConversationId: string | null;
  settings: unknown;
}

/** Reads the persisted chat state, decrypting the storage envelope. */
export async function getChatSnapshot(): Promise<ChatPersistedState | null> {
  try {
    const adapter = createEncryptedStorage();
    const raw = await adapter.getItem(CHAT_STORAGE_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Partial<ChatPersistedState> };
    const state = parsed.state;
    if (!state || !Array.isArray(state.conversations)) return null;
    return {
      conversations: state.conversations,
      activeConversationId: state.activeConversationId ?? null,
      settings: state.settings ?? null,
    };
  } catch (err) {
    console.warn("Chat snapshot collect failed:", err);
    return null;
  }
}

/**
 * Applies a remote chat snapshot through the persist middleware so
 * the change re-encrypts and writes to local storage exactly like a
 * local edit. Skipped while streaming to protect in-flight output.
 */
export async function applyChatSnapshot(snapshot: unknown): Promise<void> {
  if (!snapshot || typeof snapshot !== "object") return;
  const snap = snapshot as Partial<ChatPersistedState>;
  if (!Array.isArray(snap.conversations)) return;

  // Never clobber a live stream (pulls can land mid-generation)
  if (useChatStore.getState().isStreaming) return;

  try {
    const partial: Partial<ChatPersistedState> = {
      conversations: snap.conversations,
    };
    if (snap.activeConversationId !== undefined) {
      partial.activeConversationId = snap.activeConversationId;
    }
    if (snap.settings && typeof snap.settings === "object") {
      partial.settings = snap.settings;
    }

    // Plain setState flows through the persist middleware, so the
    // change is re-encrypted and written to local storage exactly
    // like a local edit.
    useChatStore.setState(partial as never);
  } catch (err) {
    console.warn("Chat snapshot apply failed:", err);
  }
}
