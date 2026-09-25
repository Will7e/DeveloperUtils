// ============================================================
// Tool Contracts — Every Tool Declares Its Decision
// ============================================================
// The registry test next to tool-registry.ts proves the wire schema is
// well-formed. This one proves the DECISION beside it exists, is not a
// placeholder, and can be turned into prompt prose without advertising a tool
// the turn did not offer.

import { describe, it, expect } from "vitest";
import { TOOL_CONTRACTS, contractFor, confusionPairs } from "./tool-contracts";
import { TOOL_REGISTRY } from "./tool-registry";
import {
  APP_PROMPT_TOOLS,
  REPO_CHANGE_GROUP,
  REPO_COLLAB_GROUP,
  REPO_GUARDRAIL_GROUP,
  REPO_MCP_GROUP,
  REPO_PROMPT_TOOLS,
  REPO_READ_GROUP,
  REPO_VERIFY_GROUP,
  appPromptLines,
  repoPromptLines,
  undocumentedTools,
} from "./tool-prompt";

const EFFECTS = ["none", "workspace", "app-data", "external", "user-view"];
const AUTONOMY = ["act", "undoable", "ask", "blocked"];
const CLASSES = ["public", "project", "personal", "secret"];

describe("every registered tool declares its decision", () => {
  it.each(TOOL_REGISTRY.map((t) => t.name))("%s", (name) => {
    const contract = contractFor(name);
    expect(contract, `no contract for ${name}`).toBeDefined();
    // "when" and "how" are the two fields the prompt is built from, so a stub
    // here is a tool the model is told about but not told how to use.
    expect(contract!.when.length, `${name}.when`).toBeGreaterThan(10);
    expect(contract!.how.length, `${name}.how`).toBeGreaterThan(10);
    expect(EFFECTS, `${name}.effects`).toContain(contract!.effects);
    expect(AUTONOMY, `${name}.autonomy`).toContain(contract!.autonomy);
    expect(CLASSES, `${name}.sensitivity`).toContain(contract!.sensitivity);
  });

  it("has no contract for a name that is not a registered tool", () => {
    const registered = new Set(TOOL_REGISTRY.map((t) => t.name as string));
    const orphans = Object.keys(TOOL_CONTRACTS).filter((name) => !registered.has(name));
    expect(orphans, "these contracts name tools the registry does not have").toEqual([]);
  });

  it("points every insteadOf at a real tool", () => {
    const registered = new Set(TOOL_REGISTRY.map((t) => t.name as string));
    for (const pair of confusionPairs()) {
      expect(registered.has(pair.b), `${pair.a} points at unknown tool ${pair.b}`).toBe(true);
      expect(pair.discriminator.length, `${pair.a} discriminator`).toBeGreaterThan(20);
    }
  });

  it("gives two mutually confused tools DIFFERENT discriminators", () => {
    // Each tool states when IT is the right one. If a pair says the same thing
    // from both sides, the model has been handed a coin flip.
    const pairs = confusionPairs();
    for (const pair of pairs) {
      const reverse = pairs.find((p) => p.a === pair.b && p.b === pair.a);
      if (!reverse) continue;
      expect(
        reverse.discriminator,
        `${pair.a}/${pair.b} declare the same discriminator`
      ).not.toBe(pair.discriminator);
    }
  });
});

describe("prompt generation", () => {
  it("files every tool under exactly one prompt group", () => {
    // A tool missing from both blocks is one the model is never told about,
    // which is the same as not shipping it.
    expect(undocumentedTools()).toEqual([]);
  });

  it("keeps the repo groups disjoint and complete", () => {
    const groups = [
      REPO_READ_GROUP,
      REPO_CHANGE_GROUP,
      REPO_VERIFY_GROUP,
      REPO_COLLAB_GROUP,
      REPO_GUARDRAIL_GROUP,
      REPO_MCP_GROUP,
    ];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const name of group) {
        expect(seen.has(name), `${name} appears in two groups`).toBe(false);
        seen.add(name);
      }
    }
    expect([...seen].sort()).toEqual([...REPO_PROMPT_TOOLS].sort());
  });

  it("partitions the registry into repo tools and repo-free tools", () => {
    const all = TOOL_REGISTRY.map((t) => t.name as string).sort();
    const union = [...REPO_PROMPT_TOOLS, ...APP_PROMPT_TOOLS].sort();
    expect(union).toEqual(all);
  });

  it("documents every tool when no surface is given", () => {
    const prompt = [...repoPromptLines(), ...appPromptLines()].join("\n");
    for (const tool of TOOL_REGISTRY) {
      expect(prompt, tool.name).toContain(tool.name);
    }
  });

  it("never describes a tool outside the surface it is given", () => {
    // The bug this prevents: the app block named all fourteen app tools on
    // every turn, including the three the lean profile withholds, so a free
    // model was told about `http_write`, was not offered it, and called it.
    const leanSurface = [
      "read_file",
      "edit_file",
      "search_workspace",
      "http_request",
      "run_code",
      "ask_user",
      "suggest_next",
      "read_skill",
    ];
    const appBlock = appPromptLines(leanSurface).join("\n");
    expect(appBlock).toContain("http_request");
    for (const withheld of ["http_write", "create_diagram", "open_in_tool"]) {
      expect(appBlock, `${withheld} must not be described`).not.toContain(withheld);
    }
  });

  it("never describes a withheld repository tool either", () => {
    const repoBlock = repoPromptLines(["read_file", "search_workspace"]).join("\n");
    expect(repoBlock).toContain("read_file");
    for (const withheld of ["push_changes", "run_command", "write_file", "delegate"]) {
      expect(repoBlock, `${withheld} must not be described`).not.toContain(withheld);
    }
  });

  it("names the sibling to reach for in a tool's own line", () => {
    const appBlock = appPromptLines(["http_request", "http_write"]).join("\n");
    expect(appBlock).toContain("http_write");
    expect(appBlock).toContain("http_request");
    // The discriminating sentence itself, not just the name twice.
    expect(appBlock).toMatch(/FETCH or inspect/i);
  });
});
