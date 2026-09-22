// ============================================================
// Mention Context — turning "@path" into actual bytes
// ============================================================
// The composer's "@" picker is the visible half; this is the half that
// changes an answer. When the user sends a message that mentions a file,
// the file's CURRENT content — workspace edit first, repository second —
// is attached to that message, so the model is looking at the same code
// the user is.
//
// Two deliberate choices:
//   * A mention that cannot be read is REPORTED, never dropped. Silently
//     sending a prompt that references a file nobody attached is how you
//     get a confident answer about code the model never saw.
//   * Reading merges into the workspace, so a mentioned file becomes part
//     of the working copy and the agent can edit it later without a second
//     fetch. That is a side effect with a real benefit, and it is the same
//     behaviour the agent's own read_file has.

import { selectWorkspace, useChatStore } from "@/stores/chat.store";
import type { MentionFile } from "../lib/mentions";
import { buildMentionBlock, extractMentions } from "../lib/mentions";
import { flushWorkspaceSave, readFile } from "../workspace/workspace";

export interface MentionResolution {
  /** The message text with the reference block appended (unchanged when none) */
  text: string;
  /** Paths that were attached */
  attached: string[];
  /** Paths that could not be read, with the reason */
  failures: Array<{ path: string; reason: string }>;
}

/**
 * Resolves every mention in `text`. Never throws: a failed read becomes a
 * failure entry the caller can surface, because losing the message the
 * user typed would be far worse than losing the attachment.
 */
export async function resolveMentionContext(
  conversationId: string | null,
  text: string
): Promise<MentionResolution> {
  if (!conversationId) return { text, attached: [], failures: [] };

  // Fail closed: attaching files from another repository's tree would send the
  // model files that are not in the repository under discussion.
  const ws = selectWorkspace(useChatStore.getState(), conversationId);
  if (!ws) return { text, attached: [], failures: [] };

  const known = ws.tree.map((entry) => entry.path);
  const mentioned = extractMentions(text, known);
  if (mentioned.length === 0) return { text, attached: [], failures: [] };

  const token = useChatStore.getState().settings.github.token;
  const files: MentionFile[] = [];
  const failures: Array<{ path: string; reason: string }> = [];
  let merged = ws;

  // Sequential on purpose: a workspace is a read-modify-write value, so
  // concurrent merges on one snapshot would drop all but the last file.
  for (const path of mentioned) {
    try {
      const result = await readFile(merged, token, path);
      merged = result.ws;
      if (result.content === null) {
        failures.push({ path, reason: result.error ?? "could not be read" });
        continue;
      }
      files.push({ path, content: result.content });
    } catch (err) {
      failures.push({ path, reason: err instanceof Error ? err.message : "could not be read" });
    }
  }

  if (merged !== ws) {
    useChatStore.getState().setWorkspace(conversationId, merged);
    void flushWorkspaceSave(conversationId, merged);
  }

  const block = buildMentionBlock(files);
  return {
    text: block ? `${text}${block}` : text,
    attached: files.map((f) => f.path),
    failures,
  };
}
