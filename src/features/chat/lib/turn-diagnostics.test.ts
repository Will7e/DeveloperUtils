// ============================================================
// Turn Diagnostics — tests
// ============================================================
// The properties worth pinning are the ones that decide whether this surface is
// trusted: a note hangs under the right turn, it never contradicts a fresh
// verification pass, and efficiency notes never read as warnings.

import { describe, expect, it } from "vitest";
import { diagnosticsLabel, turnAnchors, turnDiagnostics } from "./turn-diagnostics";
import { splitTurns } from "./failure-taxonomy";
import type {
  ChatConversation,
  ChatMessage,
  ToolCallRequest,
  ToolName,
} from "../types";

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function user(content: string): ChatMessage {
  return { id: id("u"), role: "user", content, timestamp: 0 };
}

function assistant(content: string): ChatMessage {
  return { id: id("a"), role: "assistant", content, timestamp: 0 };
}

function toolCalls(calls: Array<{ name: ToolName; arguments: string }>): ChatMessage {
  const requests: ToolCallRequest[] = calls.map((c) => ({
    id: id("call"),
    name: c.name,
    arguments: c.arguments,
  }));
  return {
    id: id("tc"),
    role: "assistant",
    content: "",
    timestamp: 0,
    toolCalls: { kind: "tool_calls", calls: requests },
  };
}

function toolResult(callId: string, ok = true, content = "{}"): ChatMessage {
  return {
    id: id("tr"),
    role: "user",
    content: "",
    timestamp: 0,
    toolResult: { kind: "tool_result", callId, name: "read_file", ok, content, durationMs: 3 },
  };
}

function conversation(messages: ChatMessage[]): ChatConversation {
  return { id: "c1", title: "t", createdAt: 0, updatedAt: 0, messages };
}

/** A turn that writes a source file and runs nothing to check it */
function unverifiedWriteTurn(): ChatMessage[] {
  const calls = toolCalls([{ name: "write_file", arguments: '{"path":"src/poller.ts"}' }]);
  const callId = calls.toolCalls!.calls[0]!.id;
  return [user("add backoff to the poller"), calls, toolResult(callId), assistant("Done — added backoff.")];
}

describe("turnDiagnostics — attaching the taxonomy to the turn it describes", () => {
  it("notes a turn that wrote source and ran nothing", () => {
    const [diagnostic] = turnDiagnostics({ conversation: conversation(unverifiedWriteTurn()) });
    expect(diagnostic?.notes.map((n) => n.kind)).toContain("unverified-writes");
    const note = diagnostic!.notes.find((n) => n.kind === "unverified-writes")!;
    expect(note.severity).toBe("warning");
    // The fix is carried, not just the complaint: a note that points nowhere is
    // something to ignore.
    expect(note.fix).toMatch(/verification ladder|run_checks/);
    expect(note.label).toBe("Wrote code without running anything");
  });

  it("hangs the notes under the turn's LAST assistant prose", () => {
    const messages = [
      ...unverifiedWriteTurn(),
      assistant("Actually, let me also mention the config file."),
    ];
    const [diagnostic] = turnDiagnostics({ conversation: conversation(messages) });
    expect(diagnostic?.endMessageId).toBe(messages[messages.length - 1]!.id);
  });

  it("says nothing about a turn that has not produced prose yet", () => {
    // A turn mid-flight (tool call last, no reply yet) has nowhere to hang a
    // note, and a note appearing under the cursor is worse than a late one.
    const messages = [user("go"), ...unverifiedWriteTurn().slice(1, 3)];
    expect(turnDiagnostics({ conversation: conversation(messages) })).toEqual([]);
  });

  it("drops the unverified-writes note once a check passed against this revision", () => {
    const messages = unverifiedWriteTurn();
    expect(turnDiagnostics({ conversation: conversation(messages) }).length).toBe(1);
    expect(
      turnDiagnostics({ conversation: conversation(messages), verifiedRevision: true })
    ).toEqual([]);
  });

  it("keeps the kinds a later check cannot answer, even when verified", () => {
    // The same call, twice, with identical arguments — no verification run makes
    // that not have happened.
    const calls = toolCalls([
      { name: "read_file", arguments: '{"path":"src/a.ts"}' },
      { name: "read_file", arguments: '{"path":"src/a.ts"}' },
    ]);
    const messages = [user("look"), calls, assistant("Read it.")];
    const notes = turnDiagnostics({
      conversation: conversation(messages),
      verifiedRevision: true,
    })[0]?.notes;
    expect(notes?.map((n) => n.kind)).toContain("repeated-call");
  });

  it("treats reading five files one at a time as a note, never a warning", () => {
    const calls = toolCalls(
      ["a", "b", "c", "d", "e"].map((name) => ({
        name: "read_file" as ToolName,
        arguments: `{"path":"src/${name}.ts"}`,
      }))
    );
    const notes = turnDiagnostics({
      conversation: conversation([user("understand this"), calls, assistant("Here is the summary.")]),
    })[0]?.notes;
    const overRead = notes?.find((n) => n.kind === "over-read");
    expect(overRead?.severity).toBe("note");
  });

  it("numbers turns the way the taxonomy does, so a note matches a report", () => {
    const messages = [
      ...unverifiedWriteTurn(),
      user("now do it again"),
      toolCalls([{ name: "write_file", arguments: '{"path":"src/other.ts"}' }]),
      assistant("Done again."),
    ];
    const diagnostics = turnDiagnostics({ conversation: conversation(messages) });
    expect(diagnostics.map((d) => d.turn)).toEqual([1, 2]);
    // And the anchors are distinct messages, one per turn.
    expect(new Set(diagnostics.map((d) => d.endMessageId)).size).toBe(2);
  });

  it("agrees with the taxonomy's turn boundaries, turn for turn", () => {
    // The boundary rule is mirrored from `splitTurns`; this is the test that
    // catches it drifting, because a drift puts a turn's notes under the wrong
    // reply and nothing else would notice.
    const messages = [
      ...unverifiedWriteTurn(),
      user("and again"),
      assistant("Nothing to do."),
      user("third"),
      ...unverifiedWriteTurn().slice(1),
    ];
    const turns = splitTurns(messages);
    const anchors = turnAnchors(messages);
    // Every turn in this transcript ends with prose, so each has an anchor, and
    // the numbering matches the taxonomy's 1-based turns.
    expect(anchors.size).toBe(turns.length);
    expect([...anchors.keys()].sort((a, b) => a - b)).toEqual(
      turns.map((t) => t.index)
    );
    // Only the turns that actually failed carry notes: the clean middle turn is
    // silent, which is what keeps the chip worth reading.
    expect(turnDiagnostics({ conversation: conversation(messages) }).map((d) => d.turn)).toEqual([
      1, 3,
    ]);
  });

  it("anchors each turn on its own last prose, not on a neighbour's", () => {
    const first = unverifiedWriteTurn();
    const second = unverifiedWriteTurn();
    const anchors = turnAnchors([...first, user("again"), ...second.slice(1)]);
    expect(anchors.get(1)).toBe(first[first.length - 1]!.id);
    expect(anchors.get(2)).toBe(second[second.length - 1]!.id);
  });

  it("ignores hidden messages, exactly as the taxonomy does", () => {
    const messages = unverifiedWriteTurn();
    const withHidden: ChatMessage[] = [
      ...messages,
      { ...assistant("regenerated"), hidden: true },
    ];
    const [diagnostic] = turnDiagnostics({ conversation: conversation(withHidden) });
    expect(diagnostic?.endMessageId).toBe(messages[messages.length - 1]!.id);
  });

  it("says nothing about a clean turn", () => {
    const calls = toolCalls([
      { name: "read_files", arguments: '{"paths":["src/a.ts","src/b.ts"]}' },
      { name: "run_checks", arguments: "{}" },
    ]);
    const messages = [user("check it"), calls, assistant("Read and checked.")];
    expect(turnDiagnostics({ conversation: conversation(messages) })).toEqual([]);
  });
});

describe("diagnosticsLabel — a count is only useful next to its word", () => {
  it("names a single note rather than counting it", () => {
    expect(
      diagnosticsLabel([
        { kind: "unverified-writes", label: "Wrote code without running anything", detail: "", fix: "", severity: "warning" },
      ])
    ).toBe("Wrote code without running anything");
  });

  it("calls warnings what they are", () => {
    const note = (severity: "warning" | "note") => ({
      kind: "over-read" as const,
      label: "Read one file at a time",
      detail: "",
      fix: "",
      severity,
    });
    expect(diagnosticsLabel([note("warning"), note("warning")])).toBe("2 notes");
  });

  it("does not dress efficiency notes up as warnings", () => {
    const note = {
      kind: "over-read" as const,
      label: "Read one file at a time",
      detail: "",
      fix: "",
      severity: "note" as const,
    };
    expect(diagnosticsLabel([note, note])).toBe("2 efficiency notes");
  });
});
