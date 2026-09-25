// ============================================================
// AI Chat — Cloud Sync Snapshot Bridge
// ============================================================
// Collects the persisted chat state (conversations + settings,
// including the OpenRouter key) for the cloud sync engine and
// applies remote snapshots back onto the chat store.
//
// Semantics: whole-collection last-writer-wins, matching the
// app-state bridge — with one exception carved out for live work.
// Several agents can be streaming at once, and a snapshot that
// lands mid-turn would discard their in-flight output, so the
// conversations that are streaming RIGHT NOW are held back from
// the apply and the rest of the collection lands. (The held-back
// conversations win locally, and the next push publishes them;
// the stream's own commit is the last writer for its own thread.)
// Payloads are encrypted by the sync engine (license-derived or
// pepper+account key) before leaving the device.

import { readEncryptedValue } from "@/services/encrypted-storage.service";
import { normalizeSkillsForSync, reconcileBuiltins } from "@/features/chat/lib/skills";
import { selectStreamingIds, useChatStore } from "./chat.store";

const CHAT_STORAGE_NAME = "intab_chat_state";

/** Persisted chat slice shape (mirrors the store's `partialize`). */
interface ChatPersistedState {
  conversations: unknown;
  activeConversationId: string | null;
  settings: unknown;
  /** Sidebar repo rows — persisted by the store, so they sync too */
  pinnedRepos?: unknown;
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

/**
 * Reads the persisted chat state, decrypting the storage envelope.
 *
 * Uses the read-only accessor rather than constructing a storage adapter:
 * building one per call registered a fresh pair of unload listeners on every
 * sync pull.
 */
export async function getChatSnapshot(): Promise<ChatPersistedState | null> {
  try {
    const raw = await readEncryptedValue(CHAT_STORAGE_NAME);
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
      pinnedRepos: state.pinnedRepos ?? [],
    };
  } catch (err) {
    console.warn("Chat snapshot collect failed:", err);
    return null;
  }
}

/**
 * Applies a remote chat snapshot through the persist middleware so
 * the change re-encrypts and writes to local storage exactly like a
 * local edit. Conversations with a live stream are held back — see
 * the header note — and the rest of the collection lands.
 */
export async function applyChatSnapshot(snapshot: unknown): Promise<void> {
  if (!snapshot || typeof snapshot !== "object") return;
  const snap = snapshot as Partial<ChatPersistedState>;
  if (!Array.isArray(snap.conversations)) return;

  try {
    // Never clobber a live stream: several agents can be generating at once,
    // and this apply replaces the whole collection. The conversations that
    // are streaming on THIS device are removed from the remote list (their
    // local copy, in-flight output included, wins), and everything else
    // lands. An all-streaming device therefore applies nothing — correct,
    // because there is nothing it can take without losing work.
    const streaming = new Set(selectStreamingIds(useChatStore.getState()));
    let conversations: unknown = snap.conversations;
    if (streaming.size > 0) {
      const kept = (snap.conversations as unknown[]).filter((c) => {
        if (c === null || typeof c !== "object") return true;
        const id = (c as { id?: unknown }).id;
        return typeof id !== "string" || !streaming.has(id);
      });
      // Every remote conversation belongs to a live stream here: applying
      // would take nothing and could only drop non-streaming locals the
      // remote no longer knows about, so wait for the next pull instead.
      if (kept.length === 0 && snap.conversations.length > 0) return;
      conversations = kept;
    }

    const partial: Partial<ChatPersistedState> = {
      conversations,
    };
    if (snap.activeConversationId !== undefined) {
      partial.activeConversationId = snap.activeConversationId;
    }
    if (snap.settings && typeof snap.settings === "object") {
      // The store's `merge` sanitizes settings only when they arrive from
      // local storage; a remote snapshot is the other door old or foreign
      // settings come through, and it gets the same treatment: skills are
      // normalized and shipped builtins reconciled, and the retired local
      // companion's pairing is dropped rather than carried forward.
      const settings = snap.settings as Record<string, unknown>;
      const skills = normalizeSkillsForSync(settings.skills);
      partial.settings = {
        ...settings,
        skills: reconcileBuiltins(skills) ?? skills,
        companion: undefined,
      };
    }
    if (Array.isArray(snap.pinnedRepos)) {
      partial.pinnedRepos = snap.pinnedRepos;
    }

    // Plain setState flows through the persist middleware, so the
    // change is re-encrypted and written to local storage exactly
    // like a local edit.
    useChatStore.setState(partial as never);
  } catch (err) {
    console.warn("Chat snapshot apply failed:", err);
  }
}
