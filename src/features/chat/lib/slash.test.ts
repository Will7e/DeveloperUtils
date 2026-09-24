// ============================================================
// Slash Input — Resolution Rules
// ============================================================
// These cases exist because the old composer only guarded the EXACT
// command case: any other "/" draft fell through to the send handler
// and was posted as a user message ("/comp" and "/zzz" both became
// prompts). The rules below are the contract that closed that hole.

import { describe, it, expect } from "vitest";
import { parseSlashInput, resolveSlashInput, rankCommandSpecs } from "./slash";
import { CHAT_COMMANDS } from "./commands";

describe("parseSlashInput", () => {
  it("splits a slash draft into token + argument", () => {
    expect(parseSlashInput("/model sonnet 4.5")).toEqual({
      isSlash: true,
      token: "model",
      arg: "sonnet 4.5",
    });
    expect(parseSlashInput("/compact")).toEqual({ isSlash: true, token: "compact", arg: "" });
    expect(parseSlashInput("   /Stop  ")).toEqual({ isSlash: true, token: "stop", arg: "" });
  });

  it("treats ordinary text as a message", () => {
    expect(parseSlashInput("what is a slash command?")).toEqual({
      isSlash: false,
      token: "",
      arg: "",
    });
  });
});

describe("resolveSlashInput", () => {
  it("resolves an exact command with its argument", () => {
    expect(resolveSlashInput("/rename Release plan", CHAT_COMMANDS)).toEqual({
      kind: "command",
      id: "rename",
      arg: "Release plan",
    });
  });

  it("is case-insensitive", () => {
    expect(resolveSlashInput("/Compact", CHAT_COMMANDS)).toEqual({
      kind: "command",
      id: "compact",
      arg: "",
    });
  });

  it("completes an unambiguous prefix (menu-style)", () => {
    expect(resolveSlashInput("/comp", CHAT_COMMANDS)).toEqual({
      kind: "command",
      id: "compact",
      arg: "",
    });
  });

  it("refuses to guess between several prefix matches", () => {
    // /s could be /stop, /system or /settings
    expect(resolveSlashInput("/s", CHAT_COMMANDS)).toEqual({ kind: "unknown", token: "s" });
  });

  it("resolves keywords/aliases", () => {
    expect(resolveSlashInput("/cancel", CHAT_COMMANDS)).toEqual({
      kind: "command",
      id: "stop",
      arg: "",
    });
    expect(resolveSlashInput("/regenerate", CHAT_COMMANDS)).toEqual({
      kind: "command",
      id: "retry",
      arg: "",
    });
  });

  it("reports a bare unknown token instead of sending it", () => {
    expect(resolveSlashInput("/zzz", CHAT_COMMANDS)).toEqual({ kind: "unknown", token: "zzz" });
    expect(resolveSlashInput("/", CHAT_COMMANDS)).toEqual({ kind: "unknown", token: "" });
  });

  it("treats an unmatched token WITH arguments as prose", () => {
    // A real sentence that happens to start with a slash must still send.
    expect(resolveSlashInput("/usr/bin/env python is broken", CHAT_COMMANDS)).toEqual({
      kind: "message",
    });
    // …and unknown tokens that carry arguments are prose too
    expect(resolveSlashInput("/doesnotexist some args", CHAT_COMMANDS)).toEqual({
      kind: "message",
    });
  });

  it("sends non-slash text unchanged", () => {
    expect(resolveSlashInput("summarize this", CHAT_COMMANDS)).toEqual({ kind: "message" });
  });

  it("keeps every registry id resolvable (no id/alias collisions)", () => {
    for (const command of CHAT_COMMANDS) {
      expect(resolveSlashInput(`/${command.id}`, CHAT_COMMANDS)).toEqual({
        kind: "command",
        id: command.id,
        arg: "",
      });
    }
  });

  it("has no duplicate ids or keywords that would shadow another command", () => {
    const ids = new Set<string>();
    const terms = new Set<string>();
    for (const command of CHAT_COMMANDS) {
      expect(ids.has(command.id)).toBe(false);
      ids.add(command.id);
      for (const keyword of command.keywords ?? []) {
        expect(terms.has(keyword), `duplicate keyword: ${keyword}`).toBe(false);
        terms.add(keyword);
      }
    }
    // No keyword may be another command's id (that would shadow it)
    for (const term of terms) expect(ids.has(term)).toBe(false);
  });
});

describe("rankCommandSpecs", () => {
  const specs = [
    { id: "status", description: "Report this session", keywords: ["debug"] },
    { id: "stop", description: "Stop the reply", keywords: ["cancel"] },
    { id: "context", description: "Show the context window", keywords: ["usage"] },
  ];

  it("returns everything for an empty query (registry order)", () => {
    expect(rankCommandSpecs(specs, "").map((s) => s.id)).toEqual(["status", "stop", "context"]);
  });

  it("ranks exact id first, then prefix, then keyword, then description", () => {
    expect(rankCommandSpecs(specs, "stop")[0]!.id).toBe("stop");
    expect(rankCommandSpecs(specs, "st").map((s) => s.id)).toEqual(["status", "stop"]);
    expect(rankCommandSpecs(specs, "cancel")[0]!.id).toBe("stop");
    expect(rankCommandSpecs(specs, "window")[0]!.id).toBe("context");
  });

  it("drops non-matches entirely", () => {
    expect(rankCommandSpecs(specs, "nothing-matches-this")).toEqual([]);
  });
});
