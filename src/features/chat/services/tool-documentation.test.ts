// ============================================================
// Tool Documentation — The Prompt Cannot Drift From The Registry
// ============================================================
// The composed agent prompt describes tools BY HAND. That is fine — prose
// beats a schema dump — but it means adding a tool to the registry and
// forgetting its line is a silent capability loss: the model is handed a
// schema it was never told the purpose of, so it will not call it. That is
// exactly what happened to the execution tiers (run_command,
// verify_with_ci), which existed for a while before the prompt admitted it.
//
// This test makes that drift a failure instead of a discovery.
// ============================================================

import { describe, expect, it } from "vitest";

import { TOOL_REGISTRY } from "../lib/tool-registry";
import { isUntrustedTool } from "../lib/untrusted";
import type { RepoContext } from "../types";
import { composeRepoPrompt } from "./turn-prep";

const repo: RepoContext = {
  owner: "example",
  repo: "project",
  branch: "main",
  attachedAt: 0,
};

describe("the agent prompt documents every registered tool", () => {
  const prompt = composeRepoPrompt(repo);

  it.each(TOOL_REGISTRY.map((tool) => tool.name))("names %s", (name) => {
    expect(prompt).toContain(name);
  });

  it("covers a tool added later, not just the present set", () => {
    // Guards the guard: if the registry were empty or the prompt were
    // truncated, the loop above would pass vacuously.
    expect(TOOL_REGISTRY.length).toBeGreaterThan(20);
    expect(prompt.length).toBeGreaterThan(2000);
  });
});

describe("untrusted-result coverage", () => {
  it("wraps web page content, which is authored by strangers", () => {
    expect(isUntrustedTool("fetch_url")).toBe(true);
  });

  it("wraps every source of externally-authored text", () => {
    for (const tool of ["read_file", "search_code", "fetch_url", "call_mcp_tool", "delegate"]) {
      expect(isUntrustedTool(tool)).toBe(true);
    }
  });

  it("does not wrap tools whose results this app itself authors", () => {
    // Over-wrapping is not harmless: it teaches the model that ordinary
    // results are suspect, and the rule loses force where it matters.
    for (const tool of ["get_workspace_diff", "run_checks", "update_plan"]) {
      expect(isUntrustedTool(tool)).toBe(tool === "get_workspace_diff");
    }
  });
});
