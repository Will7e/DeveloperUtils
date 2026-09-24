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
      for (const id of ["model", "effort", "compact", "settings"]) {
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

  // The menu is the whole discoverable surface now: the read-outs these
  // commands printed live in the context card and the console, so leaving
  // them registered would put two surfaces back in the business of
  // disagreeing about the same numbers.
  it("does not offer the commands that moved onto a surface", () => {
    for (const id of ["log", "scorecard", "context", "status", "tools", "help", "skills"]) {
      expect(CHAT_COMMAND_BY_ID.has(id), `/${id} should be gone`).toBe(false);
      // A query for the old name may still match another command's wording
      // ("context" appears in /compact's description), so the assertion is
      // that the removed ID itself is never offered.
      expect(ids(idle, id), `/${id} should not be offered`).not.toContain(id);
    }
  });

  // The menu prints a header when the group CHANGES, so a command whose
  // group reappears later in the list renders a second header for it
  // ("Agent" again, below "Model"). Registry order has to keep each group
  // contiguous for the rendered sections to match the group list.
  it("keeps each group contiguous, so no section header repeats", () => {
    const seen = new Set<string>();
    let previous = "";
    for (const command of commandsFor("", idle)) {
      if (command.group === previous) continue;
      expect(seen.has(command.group), `group ${command.group} appears twice`).toBe(false);
      seen.add(command.group);
      previous = command.group;
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
