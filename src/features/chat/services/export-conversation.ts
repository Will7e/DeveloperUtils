// ============================================================
// Export Conversation — Markdown Transcript Export
// ============================================================
// A leaf module on purpose: the command registry (/export) and any
// UI affordance need this, and importing it from the runner would
// make the registry depend on the whole turn engine.
//
// The transcript exported here is the session log exactly as stored:
// visible messages only, with compaction markers, tool calls, and
// attachments summarized inline so the file describes what the model
// actually saw.

import { useChatStore } from "@/stores/chat.store";
import { DEFAULT_CHAT_SETTINGS } from "../constants";
import { displayNameFor } from "../lib/intab-llm";
import { visibleMessages } from "../types";

/** Exports a conversation to a Markdown string */
export function exportConversationToMarkdown(conversationId: string): string | null {
  const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conv) return null;

  const lines: string[] = [
    `# ${conv.title}`,
    "",
    `_Model: ${displayNameFor(conv.model ?? DEFAULT_CHAT_SETTINGS.defaultModel, [])} · Exported ${new Date().toLocaleString()}_`,
    "",
  ];

  for (const m of visibleMessages(conv.messages)) {
    if (m.compactedFrom !== undefined) {
      lines.push(`> _…${m.compactedFrom} earlier messages hidden by context compaction…_`, "");
      continue;
    }
    if (m.toolCalls) {
      const names = m.toolCalls.calls.map((c) => c.name).join(", ");
      lines.push(`> _🛠 Assistant used tools: ${names}_`, "");
      continue;
    }
    if (m.toolResult) {
      lines.push(
        `> _↳ ${m.toolResult.name}${m.toolResult.ok ? "" : " (error)"} · ${m.toolResult.summary ?? ""} · ${m.toolResult.durationMs}ms_`,
        ""
      );
      continue;
    }
    const who = m.role === "user" ? "## You" : "## Assistant";
    lines.push(who, "", m.content, "");
    const imageNames = (m.attachments ?? []).filter((a) => a.dataUrl).map((a) => a.name);
    if (imageNames.length > 0) {
      lines.push("", `> _Attached image${imageNames.length === 1 ? "" : "s"}: ${imageNames.join(", ")}_`);
    }
  }

  return lines.join("\n");
}

/** Triggers a Markdown file download for the conversation */
export function downloadConversation(conversationId: string): void {
  const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId);
  const md = exportConversationToMarkdown(conversationId);
  if (!conv || !md) return;

  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${conv.title.replace(/[^\w\d-]+/g, "-").toLowerCase() || "chat"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
