// ============================================================
// Command Registry — Availability & Integrity
// ============================================================
// The menu is the discoverable half of the slash system, so what it
// offers matters as much as what commands do:
//   · streaming-only commands (/stop) appear exactly when useful,
//   · commands that need a settled transcript (/retry, /clear) do not,
//   · a fully typed token is always offered, so Enter explains
//     instead of doing nothing,
//   · every id is unique and grouped.

import { describe, it, expect } from "vitest";
import { CHAT_COMMANDS, CHAT_COMMAND_BY_ID, COMMAND_GROUPS, commandsFor } from "./commands";

const idle = { isStreaming: false };
const streaming = { isStreaming: true };

const ids = (ctx: { isStreaming: boolean }, query = "") =>
  commandsFor(query, ctx).map((c) => c.id);

describe("commandsFor availability", () => {
  it("offers /stop only while a reply is streaming", () => {
    expect(ids(streaming)).toContain("stop");
    expect(ids(idle)).not.toContain("stop");
  });

  it("hides the commands that need a settled transcript while streaming", () => {
    expect(ids(streaming)).not.toContain("retry");
    expect(ids(streaming)).not.toContain("clear");
    expect(ids(idle)).toContain("retry");
    expect(ids(idle)).toContain("clear");
  });

  it("still offers a fully typed token when it is not applicable", () => {
    // Typing /stop while idle must reach the command (which explains
    // that nothing is running) instead of leaving the keystroke dead.
    expect(ids(idle, "stop")).toContain("stop");
  });

  it("always offers the always-on commands", () => {
    for (const ctx of [idle, streaming]) {
      for (const id of ["help", "context", "status", "model", "compact"]) {
        expect(ids(ctx), `missing /${id}`).toContain(id);
      }
    }
  });

  it("filters by query and keeps the best match first", () => {
    expect(ids(idle, "undo")[0]).toBe("undo");
    expect(ids(idle, "zzz")).toEqual([]);
  });
});

describe("command registry integrity", () => {
  it("has unique ids and a resolvable lookup map", () => {
    const seen = new Set<string>();
    for (const command of CHAT_COMMANDS) {
      expect(seen.has(command.id), `duplicate id ${command.id}`).toBe(false);
      seen.add(command.id);
      expect(CHAT_COMMAND_BY_ID.get(command.id)).toBe(command);
    }
  });

  it("keeps every command in a known group with a description and icon", () => {
    for (const command of CHAT_COMMANDS) {
      expect(COMMAND_GROUPS).toContain(command.group);
      expect(command.description.length).toBeGreaterThan(8);
      expect(command.icon).toBeTruthy();
      expect(typeof command.run).toBe("function");
    }
  });

  it("documents arguments for the commands that need them", () => {
    for (const id of ["rename", "model", "effort", "mode", "system"]) {
      expect(CHAT_COMMAND_BY_ID.get(id)?.argsHint, `/${id} needs an argsHint`).toBeTruthy();
    }
  });
});
