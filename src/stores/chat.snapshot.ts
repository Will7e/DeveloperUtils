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

/**
 * Fields copied onto an attachment when its image payload is stubbed
 * for sync. Keeps names/sizes visible on remote devices; only the
 * dataUrl (the bulky part) is dropped locally.
 */
interface StubbedAttachment {
  dataUrl?: string;
  synced?: false;
}

/**
 * Returns a copy of conversations with image payloads stripped when
 * the user excluded them from sync. Text content and attachment
 * metadata (names, sizes) still sync; each attachment gets
 * `synced: false` so the UI can explain why its thumbnail is gone.
 */
function stubImageAttachments(conversations: unknown): unknown {
  if (!Array.isArray(conversations)) return conversations;
  return conversations.map((conv) => {
    const c = conv as { messages?: Array<{ attachments?: StubbedAttachment[] }> };
    if (!Array.isArray(c?.messages)) return conv;
    const hasImages = c.messages.some((m) =>
      Array.isArray(m?.attachments) && m.attachments.some((a) => typeof a?.dataUrl === "string" && a.dataUrl.length > 0)
    );
    if (!hasImages) return conv;
    return {
      ...c,
      messages: c.messages.map((m) => {
        if (!Array.isArray(m?.attachments)) return m;
        const hasData = m.attachments.some((a) => typeof a?.dataUrl === "string" && a.dataUrl.length > 0);
        if (!hasData) return m;
        return {
          ...m,
          attachments: m.attachments.map((a) =>
            typeof a?.dataUrl === "string" && a.dataUrl.length > 0
              ? { ...a, dataUrl: undefined, synced: false as const }
            : a
          ),
        };
      }),
    };
  });
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

    const settings = state.settings as { syncImageAttachments?: boolean } | null;
    const conversations =
      settings && settings.syncImageAttachments === false
        ? stubImageAttachments(state.conversations)
        : state.conversations;

    return {
      conversations,
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
