// ============================================================
// Binding Scope — The Transcript Is Not The Only Thing A Repo Touches
// ============================================================
// The binding system closed this class of bug everywhere an artifact is
// READ: the working copy, the change set, the diff pane, the verification
// ledger, the mention picker and the tree all fail closed when they are not
// the current binding's. Every one of those is a thing the app shows or
// executes.
//
// The one surface it never covered is the MODEL'S CONTEXT, and that surface
// has no fail-closed check because it is not a read at all — it is the whole
// transcript, replayed to the model on every request. So a chat that read
// `src/auth/session.ts` while attached to repository A, then switched to B,
// still hands the model A's file bodies, A's search hits, A's diffs and the
// arguments of A's writes (which contain entire file contents). The system
// prompt says the thread is on B. Nothing in the message list says which
// repository any of it came from. Asked about "the session helper", a model
// with A's body in front of it answers from A — and the user, looking at a chat
// that says B in the header, reads it as a claim about B.
//
// This module draws the boundary, at the last possible point: when the request
// is built. It keeps the user's own words and the model's own prose — those are
// the conversation — and drops the tool exchanges that carry another
// repository's FACTS, replacing the first one with a note that says where the
// removed steps came from.
//
// Three rules make that precise rather than blunt:
//
//   • A row that DECLARES a different binding is scoped. That is the exact
//     case, and it costs nothing to be exact.
//   • A row with NO provenance is scoped only when the conversation tells us
//     it predates a move (`bindingMove`): the era began at a known instant, so
//     rows older than that were recorded under an attachment that is not the
//     current one. Without this the fix could only ever protect chats that
//     switched AFTER the stamp shipped — which is not the chat the user is
//     looking at. With it, a row of unknown origin is judged by the only other
//     thing we know about it: when it was written.
//   • Only repository-derived tools are dropped. `run_code`, `search_web`
//     and the rest of the registry's repo-free surface produce output that is
//     a function of their arguments, not of a checkout, so `[1,2,3].map(f)`
//     printing `[2,4,6]` stays in context across a repository switch. The
//     registry's own `repoFree` flag decides, so this rule cannot drift from
//     the tool table.
//
// The cost of the second rule, stated rather than hidden: a chat that left A
// for B and came BACK to A has pre-move rows that are A's own facts, and they
// are withheld. It fails in the direction that loses a re-read, never in the
// direction that answers with the wrong checkout — which is the trade this
// module exists to make.
//
// Pure: messages in, messages out, no store and no clock.

import type { ChatMessage, ToolCallRequest } from "../types";
import { isRepoFreeTool } from "../lib/tool-registry";
import { parseBindingKey } from "../identity/identity";

export interface BindingScopeOptions {
  /**
   * When this thread's current repository era began, and what it left behind.
   *
   * Absent means "this thread never moved" — no rows are dated, and only rows
   * that declare their own provenance are scoped. That is the honest reading
   * for a chat that has only ever known one repository.
   */
  legacy?: { at: number; from: string | null };
}

export interface BindingScopeResult {
  /** The messages a request may carry, in their original order */
  messages: ChatMessage[];
  /** Tool calls withheld because they came from another repository */
  droppedCalls: number;
  /** Attachment ids (`owner/repo@branch`) the withheld calls belonged to */
  foreignAttachments: string[];
}

/** The repository label inside a binding id, for the note and diagnostics */
export function attachmentLabelOf(bindingId: string): string {
  const { attachmentId } = parseBindingKey(bindingId);
  return attachmentId ?? "no repository";
}

/**
 * How the note names the repository an undated era left behind. `null` is a
 * real answer — the chat had nothing attached when it moved — and saying so is
 * better than a blank, which a model reads as "the same repository".
 */
export function eraLabelOf(from: string | null): string {
  return from !== null && from.length > 0 ? from : "no repository";
}

/**
 * The one-line boundary note, placed where the removed steps were.
 *
 * It says three things because a model needs all three: what was removed,
 * that it belongs to another repository, and what to do instead (read it
 * again from the current checkout). Without the last one a model told "that
 * content is gone" tends to reconstruct it from memory, which is the same
 * wrong answer with extra confidence.
 */
export function bindingBoundaryNote(foreign: string[], currentBindingId: string): string {
  const other = foreign.length === 1 ? foreign[0] : foreign.join(", ");
  const current = attachmentLabelOf(currentBindingId);
  const now = current === "no repository" ? "no repository is attached now" : `the repository attached now is \`${current}\``;
  return (
    `[Harness note: ${foreign.length} tool step(s) recorded while this chat was working on \`${other}\` ` +
    `were withheld from this request — their contents belong to THAT repository, and ${now}. ` +
    "Do not use them as facts about the current checkout: read, list or search it again before " +
    "claiming anything about its files, and if the user's earlier message refers to something you " +
    "can no longer see, say so rather than reconstructing it.]"
  );
}

/**
 * Drops every tool exchange in `messages` that was recorded under a binding
 * other than `currentBindingId`, keeping everything a repository cannot have
 * authored.
 *
 * The first withheld exchange leaves a NOTE in its place. It is returned as a
 * clone of the row it replaces — same id, no `tool_calls` — because the
 * request builder's log invariant matches wire rows back to stored rows by id,
 * and a synthesized row would read as history that was never written. This is
 * the same shape `sanitizeToolProtocol` already uses to degrade a tool-calls
 * turn whose calls were cut away.
 */
export function scopeToBinding(
  messages: ChatMessage[],
  currentBindingId: string,
  options: BindingScopeOptions = {}
): BindingScopeResult {
  const foreignAttachments: string[] = [];
  let droppedCalls = 0;
  let notePlaced = false;
  const out: ChatMessage[] = [];
  /**
   * Call ids whose call was withheld, so their RESULTS are withheld too.
   *
   * A result carries the file body, the search hits, the diff — the content
   * this whole module exists to keep out — so leaving it for a later protocol
   * pass to orphan-drop is a contract that only holds as long as every caller
   * runs that pass. The request builder does; a caller that does not (a
   * preview, a future summarizer) would leak the body it was handed.
   */
  const withheldCallIds = new Set<string>();

  /** The row's own provenance, or null when it was written before the stamp */
  const declaredBinding = (message: ChatMessage): string | null =>
    typeof message.bindingId === "string" && message.bindingId.length > 0
      ? message.bindingId
      : null;

  const isForeign = (message: ChatMessage): boolean => {
    const declared = declaredBinding(message);
    return declared !== null && declared !== currentBindingId;
  };

  /**
   * A row of unknown provenance recorded before the current era began. Its
   * attachment is not recoverable, which is why the note names the era's
   * `from` — the repository that was attached when the move happened.
   */
  const isPreEra = (message: ChatMessage): boolean =>
    options.legacy !== undefined &&
    declaredBinding(message) === null &&
    message.timestamp < options.legacy.at;

  const record = (label: string): void => {
    if (!foreignAttachments.includes(label)) foreignAttachments.push(label);
  };

  for (const message of messages) {
    // A result whose call was withheld (the pair is always adjacent in
    // commit order) goes with it — without being counted again, so the
    // reported number stays in ONE unit: tool CALLS withheld.
    if (message.toolResult && withheldCallIds.has(message.toolResult.callId)) {
      continue;
    }
    if (!message.toolCalls || !(isForeign(message) || isPreEra(message))) {
      out.push(message);
      continue;
    }

    const declared = declaredBinding(message);
    record(
      declared !== null
        ? attachmentLabelOf(declared)
        : eraLabelOf(options.legacy?.from ?? null)
    );
    // A batch can mix a repository read with, say, a snippet run. The snippet
    // is kept — its output describes its own arguments, not a checkout — and
    // the repository calls go, along with exactly their results, which is also
    // what keeps the tool protocol valid (a `tool` row whose call is gone is a
    // 400 from a strict provider).
    const kept = message.toolCalls.calls.filter((c: ToolCallRequest) => isRepoFreeTool(c.name));
    for (const call of message.toolCalls.calls) {
      if (!kept.includes(call)) withheldCallIds.add(call.id);
    }
    droppedCalls += message.toolCalls.calls.length - kept.length;

    if (kept.length > 0) {
      out.push({ ...message, toolCalls: { kind: "tool_calls", calls: kept } });
      continue;
    }

    if (notePlaced) continue; // one note per request is enough
    notePlaced = true;
    const note = bindingBoundaryNote(foreignAttachments, currentBindingId);
    out.push({
      ...message,
      toolCalls: undefined,
      content: [message.content.trim(), note].filter(Boolean).join("\n\n"),
    });
  }

  if (droppedCalls === 0) return { messages, droppedCalls, foreignAttachments };
  return { messages: out, droppedCalls, foreignAttachments };
}
