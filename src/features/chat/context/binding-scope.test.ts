// ============================================================
// Binding Scope — The Repository Boundary In The Model's Context
// ============================================================
// The bug these tests pin is the one every pane-level fix misses: the reading
// surfaces all fail closed on the binding, but the transcript is not a read —
// it is the whole conversation, replayed to the model on every request. So a
// chat that read files in repository A and then switched to B still handed the
// model A's file bodies under a system prompt that says "B".
//
// The property that matters is precise, not blunt: A's FACTS go, the
// conversation stays, and output that describes its own arguments (a snippet's
// stdout) is not a fact about a checkout and survives.

import { describe, expect, it } from "vitest";
import { attachmentLabelOf, bindingBoundaryNote, eraLabelOf, scopeToBinding } from "./binding-scope";
import { composeSystemPrompt, prepareRequest } from "./engine";
import { attachmentIdFor, bindingKey } from "../identity/identity";
import type { ChatConversation, ChatMessage, RepoContext, ToolName } from "../types";

const REPO_A: RepoContext = { owner: "acme", repo: "api", branch: "main", attachedAt: 1 };
const REPO_B: RepoContext = { owner: "acme", repo: "web", branch: "main", attachedAt: 2 };

const BINDING_A = bindingKey("t1", attachmentIdFor(REPO_A));
const BINDING_B = bindingKey("t1", attachmentIdFor(REPO_B));

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  return { id: `m${Math.random().toString(36).slice(2, 8)}`, timestamp: 1, content: "", ...over };
}

function calls(calls: Array<{ id: string; name: string; arguments?: string }>, bindingId: string) {
  return msg({
    role: "assistant",
    bindingId,
    toolCalls: {
      kind: "tool_calls",
      calls: calls.map((c) => ({
        id: c.id,
        name: c.name as ToolName,
        arguments: c.arguments ?? "{}",
      })),
    },
  });
}

function result(callId: string, name: string, content: string, bindingId: string) {
  return msg({
    role: "user",
    bindingId,
    toolResult: {
      kind: "tool_result",
      callId,
      name: name as ToolName,
      ok: true,
      content,
      durationMs: 3,
      summary: "",
    },
  });
}

describe("scopeToBinding", () => {
  const transcript: ChatMessage[] = [
    msg({ role: "user", content: "what is the session helper?", bindingId: BINDING_A }),
    calls([{ id: "c1", name: "read_file", arguments: '{"path":"src/auth/session.ts"}' }], BINDING_A),
    result("c1", "read_file", '{"content":"SECRET_SOURCE_FROM_REPO_A"}', BINDING_A),
    calls([{ id: "c2", name: "run_code", arguments: '{"code":"print(1)"}' }], BINDING_A),
    result("c2", "run_code", "1", BINDING_A),
    msg({ role: "assistant", content: "It mints a signed cookie.", bindingId: BINDING_A }),
    msg({ role: "user", content: "now do the same for the web app", bindingId: BINDING_B }),
  ];

  it("withholds another repository's tool exchange and keeps the conversation", () => {
    const scoped = scopeToBinding(transcript, BINDING_B);
    const json = JSON.stringify(scoped.messages);

    // The file body from the other checkout is gone from the request…
    expect(json).not.toContain("SECRET_SOURCE_FROM_REPO_A");
    expect(json).not.toContain("src/auth/session.ts");
    // …while the user's words and the model's prose stay: they are the
    // conversation, and they are what the follow-up refers to.
    expect(scoped.messages.some((m) => m.content === "what is the session helper?")).toBe(true);
    expect(scoped.messages.some((m) => m.content.includes("signed cookie"))).toBe(true);
    expect(scoped.droppedCalls).toBe(1);
    expect(scoped.foreignAttachments).toEqual(["acme/api@main"]);
  });

  it("keeps output that describes its own arguments, not a checkout", () => {
    // `run_code` printing 1 is not a fact about a repository, so a repository
    // switch must not silently delete it from the model's context.
    const scoped = scopeToBinding(transcript, BINDING_B);
    expect(JSON.stringify(scoped.messages)).toContain('"run_code"');
    expect(scoped.messages.some((m) => m.toolResult?.name === "run_code")).toBe(true);
  });

  it("leaves a note where the removed steps were, naming both repositories", () => {
    const scoped = scopeToBinding(transcript, BINDING_B);
    const note = scoped.messages.find((m) => m.content.includes("[Harness note"))?.content ?? "";
    expect(note).toContain("acme/api@main");
    expect(note).toContain("acme/web@main");
    // The note has to say what to do instead, or a model reconstructs the
    // removed content from memory — the same wrong answer with more confidence.
    expect(note).toMatch(/read, list or search it again/);
  });

  it("says a thread is detached when the repository was removed", () => {
    const detached = bindingKey("t1", null);
    const scoped = scopeToBinding(transcript, detached);
    expect(JSON.stringify(scoped.messages)).not.toContain("SECRET_SOURCE_FROM_REPO_A");
    expect(scoped.messages.find((m) => m.content.includes("[Harness note"))?.content).toContain(
      "no repository is attached now"
    );
  });

  it("keeps rows from the binding in play, including a switch back", () => {
    const scoped = scopeToBinding(transcript, BINDING_A);
    expect(scoped.droppedCalls).toBe(0);
    expect(scoped.messages).toBe(transcript);
  });

  it("keeps rows that declare no binding, rather than deleting a chat's history", () => {
    // Rows written before this shipped carry no provenance. For a chat that
    // never left its repository they ARE that repository's facts, so with no
    // recorded move the fail-closed direction here is the opposite of the one
    // for declaring rows: keep them.
    const unstamped = [result("c9", "read_file", "EARLIER_BODY", "")];
    const scoped = scopeToBinding(unstamped, BINDING_B);
    expect(scoped.droppedCalls).toBe(0);
    expect(JSON.stringify(scoped.messages)).toContain("EARLIER_BODY");
  });

  it("dates rows with no provenance against a recorded move, and names what it left", () => {
    // The chat that is actually in front of the user: it read files before the
    // binding stamp existed, so its rows say nothing about which checkout they
    // came from — but the conversation knows when it moved and what it left,
    // and every row older than that was recorded under THAT attachment.
    const messages = [
      msg({ role: "user", content: "the session helper?", timestamp: 10 }),
      { ...calls([{ id: "c1", name: "read_file", arguments: '{"path":"src/auth/session.ts"}' }], ""), timestamp: 11 },
      { ...result("c1", "read_file", "PRE_STAMP_BODY_FROM_A", ""), timestamp: 12 },
      msg({ role: "user", content: "now the web app", timestamp: 40 }),
    ];

    const scoped = scopeToBinding(messages, BINDING_B, {
      legacy: { at: 30, from: "acme/api@main" },
    });

    const json = JSON.stringify(scoped.messages);
    expect(json).not.toContain("PRE_STAMP_BODY_FROM_A");
    expect(json).not.toContain("src/auth/session.ts");
    expect(scoped.droppedCalls).toBe(1);
    expect(scoped.foreignAttachments).toEqual(["acme/api@main"]);
    // Both messages still ride: the boundary removes facts, not the thread.
    expect(json).toContain("the session helper?");
    expect(json).toContain("now the web app");
  });

  it("leaves rows recorded AFTER the move alone, stamp or no stamp", () => {
    const messages = [
      { ...result("c1", "read_file", "CURRENT_ERA_BODY", ""), timestamp: 50 },
      msg({ role: "user", content: "later", timestamp: 90 }),
    ];
    const scoped = scopeToBinding(messages, BINDING_B, {
      legacy: { at: 30, from: "acme/api@main" },
    });
    expect(scoped.droppedCalls).toBe(0);
    expect(JSON.stringify(scoped.messages)).toContain("CURRENT_ERA_BODY");
  });

  it("does not date repo-free work in either era", () => {
    // A snippet's stdout describes its own arguments. Being old is not a
    // repository fact, so the era rule must not widen into "drop everything
    // before the move".
    const messages = [
      { ...calls([{ id: "c1", name: "run_code", arguments: '{"code":"print(1)"}' }], ""), timestamp: 5 },
      { ...result("c1", "run_code", "1", ""), timestamp: 6 },
    ];
    const scoped = scopeToBinding(messages, BINDING_B, {
      legacy: { at: 30, from: "acme/api@main" },
    });
    expect(scoped.droppedCalls).toBe(0);
    expect(JSON.stringify(scoped.messages)).toContain('"run_code"');
  });

  it("places a single note even when several exchanges are withheld", () => {
    const many = [
      calls([{ id: "a1", name: "read_file" }], BINDING_A),
      result("a1", "read_file", "one", BINDING_A),
      calls([{ id: "a2", name: "search_code" }], BINDING_A),
      result("a2", "search_code", "two", BINDING_A),
      calls([{ id: "a3", name: "read_file" }], BINDING_A),
      result("a3", "read_file", "three", BINDING_A),
    ];
    const scoped = scopeToBinding(many, BINDING_B);
    expect(scoped.droppedCalls).toBe(3);
    expect(scoped.messages.filter((m) => m.content.includes("[Harness note"))).toHaveLength(1);
  });
});

describe("attachmentLabelOf", () => {
  it("names the repository, and admits when there is none", () => {
    expect(attachmentLabelOf(BINDING_A)).toBe("acme/api@main");
    expect(attachmentLabelOf(bindingKey("t1", null))).toBe("no repository");
  });

  it("names the era an undated row was recorded in, and admits an empty one", () => {
    // `from: null` is the era that began in a chat with nothing attached — a
    // blank would read to a model as "same repository", which is the one thing
    // it must not conclude.
    expect(eraLabelOf("acme/api@main")).toBe("acme/api@main");
    expect(eraLabelOf(null)).toBe("no repository");
    expect(eraLabelOf("")).toBe("no repository");
  });

  it("writes a note that names one repository without a list", () => {
    const note = bindingBoundaryNote(["acme/api@main"], BINDING_A);
    expect(note).toContain("acme/api@main");
    expect(note).toContain("the repository attached now is `acme/api@main`");
  });
});

describe("the summary's repository caveat", () => {
  const summary = {
    text: "GOAL: add the session helper to src/auth/session.ts.",
    coversCount: 4,
    createdAt: 1,
    freedTokens: 100,
  };

  it("marks notes written on another repository, naming both sides", () => {
    const prompt = composeSystemPrompt("base", { ...summary, bindingId: BINDING_A }, BINDING_B) ?? "";
    expect(prompt).toMatch(/written while this chat was attached to a different repository/);
    expect(prompt).toContain("acme/api@main");
    expect(prompt).toContain("`acme/web@main` is attached now");
    // The summary itself still rides: the caveat is what makes it safe, not
    // its removal — the user's instructions live in there too.
    expect(prompt).toContain("session helper");
  });

  it("says nothing when the notes belong to the repository in play", () => {
    const prompt = composeSystemPrompt("base", { ...summary, bindingId: BINDING_B }, BINDING_B) ?? "";
    expect(prompt).not.toContain("different repository");
  });

  it("stays quiet for notes written before summaries carried a binding", () => {
    // Same reasoning as unstamped rows: assuming a legacy summary is foreign
    // would append a caveat to every chat upgraded into this build.
    const prompt = composeSystemPrompt("base", summary, BINDING_B) ?? "";
    expect(prompt).not.toContain("different repository");
  });
});

describe("prepareRequest with a moved repository", () => {
  function conversation(messages: ChatMessage[], repoContext?: RepoContext): ChatConversation {
    return { id: "t1", title: "t", messages, createdAt: 0, updatedAt: 0, repoContext };
  }

  it("never sends the previous repository's file bodies", () => {
    const messages = [
      msg({ role: "user", content: "read it", bindingId: BINDING_A }),
      calls([{ id: "c1", name: "read_file", arguments: '{"path":"src/auth/session.ts"}' }], BINDING_A),
      result("c1", "read_file", '{"content":"PREVIOUS_REPO_BODY"}', BINDING_A),
      msg({ role: "user", content: "and now this one", bindingId: BINDING_B }),
    ];
    const prepared = prepareRequest({ conversation: conversation(messages, REPO_B) });
    const wire = JSON.stringify(prepared.messages);
    expect(wire).not.toContain("PREVIOUS_REPO_BODY");
    expect(wire).toContain("and now this one");
    // The note survives into the wire, and the payload is still a valid
    // protocol sequence (no orphaned tool row for the withheld call).
    expect(wire).toContain("Harness note");
    expect(prepared.messages.some((m) => (m as { role: string }).role === "tool")).toBe(false);
  });

  it("withholds a pre-stamp chat's old checkout once its move is recorded", () => {
    // End to end for the reported bug: the transcript has no per-row binding at
    // all (it predates the stamp), and the app knows only that this chat moved
    // off `acme/api`. The model must not receive A's file bodies while the
    // header says B.
    const messages: ChatMessage[] = [
      { ...msg({ role: "user", content: "read the session helper" }), timestamp: 10 },
      {
        ...msg({
          role: "assistant",
          toolCalls: {
            kind: "tool_calls",
            calls: [{ id: "c1", name: "read_file" as ToolName, arguments: '{"path":"src/auth/session.ts"}' }],
          },
        }),
        timestamp: 11,
      },
      {
        ...msg({
          role: "user",
          toolResult: {
            kind: "tool_result",
            callId: "c1",
            name: "read_file" as ToolName,
            ok: true,
            content: '{"content":"PRE_STAMP_BODY_FROM_A"}',
            durationMs: 3,
            summary: "",
          },
        }),
        timestamp: 12,
      },
      { ...msg({ role: "user", content: "now the web app" }), timestamp: 40 },
    ];
    const prepared = prepareRequest({
      conversation: {
        ...conversation(messages, REPO_B),
        bindingMove: { at: 30, from: "acme/api@main" },
      },
    });
    const wire = JSON.stringify(prepared.messages);
    expect(wire).not.toContain("PRE_STAMP_BODY_FROM_A");
    expect(wire).toContain("now the web app");
    expect(wire).toContain("acme/api@main");
    expect(prepared.messages.some((m) => (m as { role: string }).role === "tool")).toBe(false);
  });

  it("still sends the current repository's reads", () => {
    const messages = [
      msg({ role: "user", content: "read it", bindingId: BINDING_B }),
      calls([{ id: "c1", name: "read_file", arguments: '{"path":"src/auth/session.ts"}' }], BINDING_B),
      result("c1", "read_file", '{"content":"CURRENT_REPO_BODY"}', BINDING_B),
    ];
    const prepared = prepareRequest({ conversation: conversation(messages, REPO_B) });
    expect(JSON.stringify(prepared.messages)).toContain("CURRENT_REPO_BODY");
  });
});
