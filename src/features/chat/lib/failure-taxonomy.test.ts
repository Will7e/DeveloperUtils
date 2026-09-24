// ============================================================
// Failure Taxonomy — One Fixture Per Way The Agent Fails
// ============================================================
// Each rule gets a transcript that exhibits it and one that looks similar but
// must NOT fire. The negative cases are the point: a taxonomy that over-reports
// sends people to fix working mechanisms, so every rule is pinned from both
// sides — a batched read is not an over-read, a harness nudge is not the model
// going quiet, an ask that had already looked is not asking before looking.

import { describe, expect, it } from "vitest";
import {
  FAILURE_FIX,
  FAILURE_KINDS,
  FAILURE_LABEL,
  classifyConversation,
  classifyTurn,
  formatFailureReport,
  splitTurns,
  taxonomyCounts,
} from "./failure-taxonomy";
import { TOOL_LIMIT_NOTICE } from "./harness-notices";
import { completionNudge } from "./completion-gate";
import { buildScorecard, formatScorecard, summarizeScorecard } from "./scorecard";
import type { ChatConversation, ChatMessage, ToolName } from "../types";

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  return { id: Math.random().toString(36), timestamp: 0, content: "", ...over };
}

/** A tool call, with the arguments the model actually emitted */
function call(name: string, args: Record<string, unknown> = {}, id = "c1") {
  return { id, name: name as ToolName, arguments: JSON.stringify(args) };
}

/** An assistant round requesting one or more tools */
function round(...calls: ReturnType<typeof call>[]): ChatMessage {
  return msg({ role: "assistant", toolCalls: { kind: "tool_calls", calls } });
}

/** A tool result paired to its call */
function result(c: ReturnType<typeof call>, ok: boolean, content: string): ChatMessage {
  return msg({
    role: "user",
    toolResult: { kind: "tool_result", callId: c.id, name: c.name, ok, content, durationMs: 1 },
  });
}

const user = (content: string) => msg({ role: "user", content });
const reply = (content: string) => msg({ role: "assistant", content });

function conversation(...messages: ChatMessage[]): ChatConversation {
  return { id: "c1", title: "t", messages, createdAt: 0, updatedAt: 0 };
}

/** The kinds a conversation was classified as */
function kinds(...messages: ChatMessage[]): string[] {
  return classifyConversation(conversation(...messages)).map((f) => f.kind);
}

// ── The ten rules ────────────────────────────────────────────

describe("a tool that does not exist", () => {
  it("is named when the registry refuses the call", () => {
    const c = call("git_status");
    expect(kinds(user("what changed?"), round(c), result(c, false, "Unknown tool: git_status"))).toContain(
      "unknown-tool"
    );
  });
});

describe("a tool the surface withheld", () => {
  const withheld =
    'Tool "http_write" is real, but it was NOT in the tool list for this turn — so it cannot be called here, and calling it again will not change that. Use `http_request` instead — it is the tool available here.';

  it("is distinguished from an invented name", () => {
    const c = call("http_write", { method: "GET", url: "https://x.test/a" });
    const found = kinds(user("fetch data from this endpoint"), round(c), result(c, false, withheld));
    expect(found).toContain("withheld-tool");
    expect(found).not.toContain("unknown-tool");
  });

  it("also counts as the wrong sibling, because the refusal had to name one", () => {
    const c = call("http_write", { method: "GET", url: "https://x.test/a" });
    expect(kinds(user("fetch it"), round(c), result(c, false, withheld))).toContain("wrong-sibling");
  });
});

describe("arguments that were rejected", () => {
  it("is the reported reproduction, escaped the way the transcript stores it", () => {
    // Exactly what the user saw, including the JSON escaping the serializer
    // applies to a failed result's payload.
    const c = call("http_write", { method: "POST", url: "https://x.test/a", headers: '{"Accept":"*/*"}' });
    const found = kinds(
      user("fetch data from this endpoint"),
      round(c),
      result(c, false, '{"error":"Argument \\"headers\\" must be of type object, got string."}')
    );
    expect(found).toContain("schema-failure");
  });

  it("also recognises the unescaped form a direct result would carry", () => {
    const c = call("read_files", { paths: "src/a.ts" });
    const found = kinds(
      user("read a"),
      round(c),
      result(c, false, 'Argument "paths" must be of type array, got string.')
    );
    expect(found).toContain("schema-failure");
  });

  it("does not fire on a failure that is not about arguments", () => {
    const c = call("read_file", { path: "src/a.ts" });
    const found = kinds(user("read it"), round(c), result(c, false, "not found at that path on main"));
    expect(found).not.toContain("schema-failure");
  });
});

describe("the same call twice", () => {
  it("counts once per turn however many times it repeats", () => {
    const a = call("read_file", { path: "src/a.ts" }, "c1");
    const b = call("read_file", { path: "src/a.ts" }, "c2");
    const c = call("read_file", { path: "src/a.ts" }, "c3");
    const findings = classifyConversation(
      conversation(
        user("read it"),
        round(a),
        result(a, false, "not found"),
        round(b),
        result(b, false, "not found"),
        round(c),
        result(c, false, "not found")
      )
    );
    const repeats = findings.filter((f) => f.kind === "repeated-call");
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.detail).toMatch(/3 times/);
  });

  it("ignores key order when it decides what is identical", () => {
    const a = call("read_file", { path: "src/a.ts", startLine: 1 }, "c1");
    const b = call("read_file", { startLine: 1, path: "src/a.ts" }, "c2");
    const found = kinds(user("read it"), round(a), result(a, true, "{}"), round(b), result(b, true, "{}"));
    expect(found).toContain("repeated-call");
  });
});

describe("the wrong sibling chosen", () => {
  it("fires when the turn eventually used the right tool", () => {
    const wrong = call("search_code", { query: "parseToolArguments" }, "c1");
    const right = call("search_workspace", { query: "parseToolArguments" }, "c2");
    const found = kinds(
      user("where is parseToolArguments used?"),
      round(wrong),
      result(wrong, false, "search_code needs an attached repository"),
      round(right),
      result(right, true, "{}")
    );
    expect(found).toContain("wrong-sibling");
  });

  it("stays silent when the failure has no sibling relationship", () => {
    const c = call("run_command", { command: "npm test" }, "c1");
    const found = kinds(user("run the tests"), round(c), result(c, false, "no companion is running"));
    expect(found).not.toContain("wrong-sibling");
  });
});

describe("going quiet after a failure", () => {
  it("fires when the final reply never mentions the failure", () => {
    const c = call("http_request", { method: "GET", url: "https://x.test/a" }, "c1");
    const found = kinds(
      user("fetch it"),
      round(c),
      result(c, false, "the endpoint could not be reached"),
      reply("Here is a summary of the endpoint's data model.")
    );
    expect(found).toContain("unanswered-failure");
  });

  it("does not fire when the reply is honest about it", () => {
    const c = call("http_request", { method: "GET", url: "https://x.test/a" }, "c1");
    const found = kinds(
      user("fetch it"),
      round(c),
      result(c, false, "the endpoint could not be reached"),
      reply("I could not reach that endpoint, so the schema below is unverified.")
    );
    expect(found).not.toContain("unanswered-failure");
  });

  it("never counts a harness continuation as the model falling silent", () => {
    const c = call("read_file", { path: "src/a.ts" }, "c1");
    const found = kinds(
      user("read it"),
      round(c),
      result(c, false, "not found"),
      reply(completionNudge([{ kind: "check-failing", label: "Command", summary: "npm test exited 1", details: [] }]))
    );
    expect(found).not.toContain("unanswered-failure");
  });
});

describe("reading one file at a time", () => {
  const fiveReads = () => {
    const calls = ["a", "b", "c", "d", "e"].map((p, i) => call("read_file", { path: `src/${p}.ts` }, `c${i}`));
    const messages: ChatMessage[] = [user("read these")];
    for (const c of calls) messages.push(round(c), result(c, true, "{}"));
    return messages;
  };

  it("fires at five separate reads with no batch or search", () => {
    expect(kinds(...fiveReads())).toContain("over-read");
  });

  it("does not fire when the same five files came from read_files", () => {
    const batch = call("read_files", { paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"] });
    const found = kinds(user("read these"), round(batch), result(batch, true, "{}"));
    expect(found).not.toContain("over-read");
  });

  it("does not fire at four reads", () => {
    const calls = ["a", "b", "c", "d"].map((p, i) => call("read_file", { path: `src/${p}.ts` }, `c${i}`));
    const messages: ChatMessage[] = [user("read these")];
    for (const c of calls) messages.push(round(c), result(c, true, "{}"));
    expect(kinds(...messages)).not.toContain("over-read");
  });
});

describe("asking before looking", () => {
  it("fires when the first read happens after the question", () => {
    const ask = call("ask_user", { question: "Which environment?" }, "c1");
    const read = call("read_file", { path: "src/config.ts" }, "c2");
    const found = kinds(
      user("make the call work"),
      round(ask),
      result(ask, true, "{}"),
      round(read),
      result(read, true, "{}")
    );
    expect(found).toContain("ask-before-looking");
  });

  it("stays silent when the agent had already read something", () => {
    const read = call("read_file", { path: "src/config.ts" }, "c1");
    const ask = call("ask_user", { question: "Which environment?" }, "c2");
    const found = kinds(user("make it work"), round(read), result(read, true, "{}"), round(ask), result(ask, true, "{}"));
    expect(found).not.toContain("ask-before-looking");
  });
});

describe("writing without running anything", () => {
  it("fires for source edits and no check", () => {
    const edit = call("edit_file", { path: "src/api.ts" }, "c1");
    expect(kinds(user("fix it"), round(edit), result(edit, true, "{}"))).toContain("unverified-writes");
  });

  it("stays silent when a check ran, even a failed one", () => {
    const edit = call("edit_file", { path: "src/api.ts" }, "c1");
    const check = call("run_checks", {}, "c2");
    const found = kinds(
      user("fix it"),
      round(edit),
      result(edit, true, "{}"),
      round(check),
      result(check, false, "2 errors")
    );
    expect(found).not.toContain("unverified-writes");
  });

  it("stays silent for documentation and manifest edits", () => {
    const edit = call("edit_file", { path: "docs/usage.md" }, "c1");
    const readme = call("write_file", { path: "README.md" }, "c2");
    const found = kinds(user("document it"), round(edit), result(edit, true, "{}"), round(readme), result(readme, true, "{}"));
    expect(found).not.toContain("unverified-writes");
  });
});

describe("running out of rounds", () => {
  it("fires on the harness's own limit notice", () => {
    expect(kinds(user("do a lot"), reply(TOOL_LIMIT_NOTICE))).toContain("round-exhaustion");
  });
});

// ── A healthy turn reports nothing ───────────────────────────

describe("a well-behaved turn", () => {
  it("classifies as no failure at all", () => {
    const search = call("search_workspace", { query: "handleToolRound" }, "c1");
    const read = call("read_file", { path: "src/turn-engine.ts", startLine: 900, endLine: 1000 }, "c2");
    const edit = call("edit_file", { path: "src/turn-engine.ts" }, "c3");
    const check = call("run_checks", {}, "c4");
    const findings = classifyConversation(
      conversation(
        user("use search_workspace instead of search_code for code I just wrote"),
        round(search),
        result(search, true, "{}"),
        round(read),
        result(read, true, "{}"),
        round(edit),
        result(edit, true, "{}"),
        round(check),
        result(check, true, "0 errors"),
        reply("Done: `search_workspace` now wins for freshly written code, and the type check is green.")
      )
    );
    expect(findings).toEqual([]);
  });
});

// ── Counting and reporting ───────────────────────────────────

describe("counts and the report", () => {
  const broken = conversation(
    user("fetch data from this endpoint"),
    round(call("http_write", { url: "https://x.test/a" }, "c1")),
    result(
      call("http_write", { url: "https://x.test/a" }, "c1"),
      false,
      'Argument "headers" must be of type object, got string.'
    ),
    round(call("http_write", { url: "https://x.test/a" }, "c1")),
    result(
      call("http_write", { url: "https://x.test/a" }, "c1"),
      false,
      'Argument "headers" must be of type object, got string.'
    )
  );

  it("counts every kind, including the zeros", () => {
    const counts = taxonomyCounts([broken]);
    expect(Object.keys(counts.byKind).sort()).toEqual([...FAILURE_KINDS].sort());
    expect(counts.turns).toBe(1);
    expect(counts.total).toBeGreaterThan(0);
    // The fixture repeats the identical failure twice on purpose — that is the
    // reported reproduction — so it is two schema failures and one repeat.
    expect(counts.byKind["schema-failure"]).toBe(2);
    expect(counts.byKind["repeated-call"]).toBe(1);
  });

  it("names a mechanism for every kind, so a report always points somewhere", () => {
    for (const kind of FAILURE_KINDS) {
      expect(FAILURE_LABEL[kind], kind).toBeTruthy();
      expect(FAILURE_FIX[kind], kind).toBeTruthy();
    }
  });

  it("prints the ranked kinds with their fix", () => {
    const counts = taxonomyCounts([broken]);
    const text = formatFailureReport(counts, classifyConversation(broken));
    expect(text).toContain("Arguments rejected");
    expect(text).toContain("arg-coercion");
    expect(text).toMatch(/turn 1:/);
  });

  it("says so plainly when there is nothing to report", () => {
    const text = formatFailureReport(taxonomyCounts([conversation(user("hello"), reply("hi"))]), []);
    expect(text).toMatch(/No classified failures/);
  });

  it("is stable: classifying twice gives the same answer", () => {
    const first = classifyConversation(broken);
    const second = classifyConversation(broken);
    expect(second).toEqual(first);
  });
});

describe("turns", () => {
  it("splits on user messages and treats a resumed transcript honestly", () => {
    const turns = splitTurns([
      msg({ role: "assistant", toolCalls: { kind: "tool_calls", calls: [call("read_file", { path: "a.ts" })] } }),
      user("first ask"),
      reply("done"),
      user("second ask"),
      reply("done"),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[0]!.calls).toHaveLength(1);
    expect(classifyTurn(turns[2]!).every((f) => f.turn === 3)).toBe(true);
  });
});

// ── The scorecard carries the numbers ────────────────────────

describe("scorecard integration", () => {
  const card = () =>
    buildScorecard([
      conversation(
        user("fetch data from this endpoint"),
        round(call("http_write", { url: "https://x.test/a" }, "c1")),
        result(call("http_write", { url: "https://x.test/a" }, "c1"), false, "Argument \"headers\" must be of type object, got string."),
        reply("I fetched it.")
      ),
    ]);

  it("attaches the classified counts and findings", () => {
    const built = card();
    expect(built.failures.total).toBeGreaterThan(0);
    expect(built.failures.byKind["schema-failure"]).toBe(1);
    expect(built.findings.length).toBe(built.failures.total);
  });

  it("prints the fired kinds, and only those", () => {
    const text = formatScorecard(card());
    expect(text).toContain("Arguments rejected");
    expect(text).not.toContain("Ran out of rounds");
    expect(text).toContain("Most recent:");
  });

  it("summarizes with the failure count", () => {
    expect(summarizeScorecard(card())).toMatch(/classified failure/);
  });

  it("prints nothing extra for a clean transcript", () => {
    const clean = buildScorecard([conversation(user("hi"), reply("hello"))]);
    expect(clean.failures.total).toBe(0);
    expect(formatScorecard(clean)).not.toContain("Most recent:");
  });
});
