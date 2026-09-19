// ============================================================
// Export Utilities for AI Chat
// Supports downloading conversations as Markdown (.md) or JSON
// ============================================================

import type { ChatConversation } from "../types";

export function exportConversationAsMarkdown(conv: ChatConversation): void {
  const lines: string[] = [
    `# ${conv.title}`,
    `Date: ${new Date(conv.createdAt).toLocaleString()}`,
    `Model: ${conv.model} (${conv.provider})`,
    "",
    "---",
    "",
  ];

  for (const msg of conv.messages) {
    const roleLabel = msg.role === "user" ? "User" : `InTab AI (${conv.model})`;
    const timeStr = new Date(msg.timestamp).toLocaleTimeString();
    lines.push(`### ${roleLabel} • ${timeStr}`);
    lines.push(msg.content);
    lines.push("");
  }

  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${conv.title.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportConversationAsJson(conv: ChatConversation): void {
  const data = JSON.stringify(conv, null, 2);
  const blob = new Blob([data], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${conv.title.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
