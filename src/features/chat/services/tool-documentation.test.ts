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

import { TOOL_REGISTRY, isRepoFreeTool } from "../lib/tool-registry";
import { isUntrustedTool } from "../lib/untrusted";
import type { RepoContext } from "../types";
import { composeAppToolsPrompt, composeRepoPrompt } from "./turn-prep";

const repo: RepoContext = {
  owner: "example",
  repo: "project",
  branch: "main",
  attachedAt: 0,
};

/**
 * The prompt is assembled from TWO blocks: the repository one (which only
 * rides a turn that has a repository) and the app one (which rides every
 * tool-capable turn). A tool can legitimately be documented in either, so
 * the coverage assertion is over the union — and the pair still cannot
 * drift from the registry, which is the invariant this file exists for.
 */
function agentPromptWithRepo(): string {
  return `${composeRepoPrompt(repo)}\n\n${composeAppToolsPrompt()}`;
}

describe("the agent prompt documents every registered tool", () => {
  const prompt = agentPromptWithRepo();

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

describe("a repository-free turn documents exactly what it can call", () => {
  const appPrompt = composeAppToolsPrompt();

  it("names every tool that survives the repo-free surface filter", () => {
    for (const tool of TOOL_REGISTRY) {
      if (!isRepoFreeTool(tool.name)) continue;
      expect(appPrompt, tool.name).toContain(tool.name);
    }
  });

  it("gives no repository tool a documentation line of its own", () => {
    // The mirror of the rule above: presenting a tool the turn cannot call
    // as available is worse than saying nothing, because the model will
    // plan around it. Checked at LINE level rather than by substring — the
    // app block may legitimately mention that something is NOT this tool
    // ("a green snippet proves the snippet, never the repository"), while a
    // bullet describing how to call it would be a real loss of capability.
    const documented = appPrompt
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .join("\n");
    for (const name of [
      "list_repo_files",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "get_workspace_diff",
      "create_working_branch",
      "push_changes",
      "search_workspace",
      "get_repo_overview",
      "run_checks",
    ]) {
      expect(documented, name).not.toContain(name);
    }
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

  it("wraps the app tools that return text authored elsewhere", () => {
    // An endpoint's error page and the reference's example code are both
    // third-party text that lands in the transcript verbatim.
    for (const tool of ["http_request", "http_write", "search_library"]) {
      expect(isUntrustedTool(tool), tool).toBe(true);
    }
  });

  it("leaves the local compute tools unwrapped", () => {
    // A snippet's stdout and a formatter's output are produced by THIS
    // machine from THIS app's input; treating them as hostile would dilute
    // the rule exactly where a real injection arrives.
    for (const tool of ["run_code", "format_code", "compare_data", "diff_text", "create_diagram"]) {
      expect(isUntrustedTool(tool), tool).toBe(false);
    }
  });
});
