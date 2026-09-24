// ============================================================
// Delegation — Nested Loop Tests
// ============================================================
// Delegation is the one place a harness can hand work to a model the
// user did not choose, so the properties that must hold are safety
// properties: the helper can never reach a mutating tool, it can never
// loop forever, and its answer can never masquerade as verified fact.

import { describe, it, expect } from "vitest";
import {
  DELEGATE_CLAIM_CAVEAT,
  DELEGATE_SYSTEM_PROMPT,
  DELEGATE_TOOL_DEFS,
  DELEGATE_TOOL_NAMES,
  delegateToolResult,
  isDelegateTool,
  pickResearchModel,
  runDelegateLoop,
  type DelegateDeps,
} from "./delegate";
import { TOOL_REGISTRY } from "../lib/tool-registry";
import type { CompleteChatWithToolsParams } from "../lib/openrouter-client";
import type { ModelInfo, RepoContext, ToolCallResult } from "../types";

const REPO: RepoContext = { owner: "acme", repo: "demo", branch: "main", attachedAt: 0 };

function toolResult(name: string, summary = "src/a.ts"): ToolCallResult {
  return { callId: "x", name: name as ToolCallResult["name"], ok: true, data: { ok: true }, durationMs: 1, summary };
}

/** Scripted helper: each entry is one completion response */
function scripted(completions: Array<{ content?: string; calls?: Array<[string, string]> }>): {
  deps: Pick<DelegateDeps, "complete">;
  seen: CompleteChatWithToolsParams[];
  executed: string[];
} {
  const seen: CompleteChatWithToolsParams[] = [];
  const executed: string[] = [];
  let i = 0;
  return {
    seen,
    executed,
    deps: {
      complete: async (params) => {
        seen.push(structuredClone({ ...params, signal: undefined }));
        const next = completions[Math.min(i, completions.length - 1)]!;
        i += 1;
        return {
          content: next.content ?? "",
          toolCalls: (next.calls ?? []).map(([name, args], idx) => ({
            id: `c${i}_${idx}`,
            name: name as never,
            arguments: args,
          })),
          usage: null,
        };
      },
    },
  };
}

function readDeps(executed: string[]): Pick<DelegateDeps, "executeRead"> {
  return {
    executeRead: async (call) => {
      executed.push(call.name);
      return toolResult(call.name);
    },
  };
}

describe("delegate allowlist", () => {
  it("contains only read-only tools", () => {
    const mutating = ["write_file", "edit_file", "delete_file", "push_changes", "create_working_branch", "remember", "delegate"];
    for (const name of mutating) {
      expect(DELEGATE_TOOL_NAMES).not.toContain(name);
      expect(isDelegateTool(name)).toBe(false);
    }
  });

  it("publishes wire definitions drawn from the real registry", () => {
    const registryNames = TOOL_REGISTRY.map((t) => t.name);
    expect(DELEGATE_TOOL_DEFS.map((d) => d.function.name)).toEqual(
      registryNames.filter((n) => DELEGATE_TOOL_NAMES.includes(n))
    );
    expect(DELEGATE_TOOL_DEFS.length).toBeGreaterThan(3);
  });

  it("carries the untrusted-content rule into the helper's instructions", () => {
    expect(DELEGATE_SYSTEM_PROMPT).toContain("<untrusted-content>");
  });

  it("gives the helper the web pair, so a lookup cannot become a guess", () => {
    // A helper asked to research something that is NOT in the checkout used to
    // have no way to look it up, and its report came back to the parent in the
    // same shape whether it read a page or recalled one. Both tools are
    // read-only, so the allowlist's read-only property is untouched.
    expect(DELEGATE_TOOL_NAMES).toContain("search_web");
    expect(DELEGATE_TOOL_NAMES).toContain("fetch_url");
    expect(isDelegateTool("search_web")).toBe(true);
    expect(DELEGATE_SYSTEM_PROMPT).toContain("search_web");
  });
});

describe("runDelegateLoop", () => {
  it("executes tool calls, then returns the helper's report", async () => {
    const executed: string[] = [];
    const { deps, seen } = scripted([
      { calls: [["read_file", '{"path":"src/a.ts"}']] },
      { content: "Retries live in src/a.ts (lines 10-40).\nEvidence: src/a.ts" },
    ]);

    const outcome = await runDelegateLoop(
      { task: "where are retries implemented?", modelId: "free/model", repo: REPO, apiKey: "k" },
      { ...deps, ...readDeps(executed) }
    );

    expect(executed).toEqual(["read_file"]);
    expect(outcome.report).toContain("src/a.ts");
    expect(outcome.iterations).toBe(2);
    expect(outcome.truncated).toBe(false);
    expect(outcome.toolLog).toEqual(["ok  read_file(src/a.ts)"]);

    // Protocol validity: the second round must show the assistant's
    // tool_calls row answered by a matching tool row, or a strict
    // provider rejects the whole nested conversation.
    const round2 = seen[1]!.messages;
    expect(round2).toHaveLength(3);
    const callsRow = round2[1] as { tool_calls: Array<{ id: string }> };
    const resultRow = round2[2] as { role: string; tool_call_id: string };
    expect(resultRow.role).toBe("tool");
    expect(resultRow.tool_call_id).toBe(callsRow.tool_calls[0]!.id);
  });

  it("refuses a tool the helper was never given", async () => {
    const executed: string[] = [];
    const { deps, seen } = scripted([
      { calls: [["push_changes", '{"commitMessage":"sneaky"}']] },
      { content: "done" },
    ]);

    await runDelegateLoop(
      { task: "t", modelId: "m", repo: REPO, apiKey: "k" },
      { ...deps, ...readDeps(executed) }
    );

    expect(executed).toEqual([]);
    const toolRow = seen[1]!.messages[2] as { content: string };
    expect(toolRow.content).toContain("not available to a delegated research task");
  });

  it("sends no tools at all when there is no repository", async () => {
    const { deps, seen } = scripted([{ content: "I cannot check without a repository." }]);
    await runDelegateLoop(
      { task: "t", modelId: "m", apiKey: "k" },
      { ...deps, ...readDeps([]) }
    );
    expect(seen[0]!.tools).toBeUndefined();
  });

  it("stops at the iteration cap and says so", async () => {
    const executed: string[] = [];
    const { deps } = scripted([{ calls: [["read_file", '{"path":"a.ts"}']] }]);

    const outcome = await runDelegateLoop(
      { task: "t", modelId: "m", repo: REPO, apiKey: "k", maxIterations: 3 },
      { ...deps, ...readDeps(executed) }
    );

    expect(outcome.iterations).toBe(3);
    expect(outcome.truncated).toBe(true);
    expect(outcome.report).toMatch(/ran out of its investigation budget/);
  });

  it("caps total tool calls across rounds", async () => {
    const executed: string[] = [];
    const many = Array.from({ length: 8 }, (_, i) => [`read_file`, `{"path":"f${i}.ts"}`] as [string, string]);
    const { deps, seen } = scripted([{ calls: many }, { calls: many }, { calls: many }, { content: "report" }]);

    const outcome = await runDelegateLoop(
      { task: "t", modelId: "m", repo: REPO, apiKey: "k", maxIterations: 4 },
      { ...deps, ...readDeps(executed) }
    );

    expect(executed).toHaveLength(16);
    expect(outcome.truncated).toBe(true);
    // The over-budget calls are answered, never dropped — the protocol
    // requires every tool_call to have a result.
    const lastRound = seen[3]!.messages;
    const calls = lastRound.filter(
      (m) => (m as { role?: string }).role === "assistant"
    ) as Array<{ tool_calls?: unknown[] }>;
    expect(calls.length).toBeGreaterThan(0);
  });

  it("returns a cancelled notice instead of throwing on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = scripted([{ content: "should not run" }]);

    const outcome = await runDelegateLoop(
      { task: "t", modelId: "m", repo: REPO, apiKey: "k", signal: controller.signal },
      { ...deps, ...readDeps([]) }
    );

    expect(outcome.report).toMatch(/cancelled/i);
    expect(outcome.truncated).toBe(true);
  });

  it("survives a tool that throws", async () => {
    const { deps, seen } = scripted([
      { calls: [["read_file", '{"path":"a.ts"}']] },
      { content: "report" },
    ]);
    const outcome = await runDelegateLoop(
      { task: "t", modelId: "m", repo: REPO, apiKey: "k" },
      {
        ...deps,
        executeRead: async () => {
          throw new Error("network exploded");
        },
      }
    );
    expect(outcome.toolLog[0]).toMatch(/^FAIL/);
    const toolRow = seen[1]!.messages[2] as { content: string };
    expect(toolRow.content).toContain("network exploded");
  });
});

describe("pickResearchModel", () => {
  const catalog: ModelInfo[] = [
    { id: "paid/big", name: "Big", contextLength: 200_000, isFree: false },
    { id: "free/small", name: "Small Free", contextLength: 32_000, isFree: true },
    { id: "free/wide", name: "Wide Free", contextLength: 131_000, isFree: true },
    { id: "free/no-tools", name: "No Tools", contextLength: 500_000, isFree: true, supportedParameters: ["chat"] },
  ];

  it("routes helpers to a free tool-capable model, preferring the widest window", () => {
    const choice = pickResearchModel("paid/big", catalog);
    expect(choice.modelId).toBe("free/wide");
    expect(choice.reason).toMatch(/free tool-capable/);
  });

  it("never routes a helper onto a model without tool support", () => {
    expect(pickResearchModel("paid/big", catalog).modelId).not.toBe("free/no-tools");
  });

  it("falls back to the conversation's model when nothing free can call tools", () => {
    const choice = pickResearchModel("paid/big", [
      { id: "free/no-tools", name: "No Tools", isFree: true, supportedParameters: ["chat"] },
    ]);
    expect(choice.modelId).toBe("paid/big");
    expect(choice.reason).toMatch(/no free tool-capable model/);
  });

  it("falls back rather than guessing when the catalog is cold", () => {
    expect(pickResearchModel("m", []).modelId).toBe("m");
  });
});

describe("delegateToolResult", () => {
  it("hands the parent a lead, not a fact", () => {
    const result = delegateToolResult(
      { report: "found it", modelId: "free/wide", toolLog: ["ok  read_file(a.ts)"], iterations: 2, truncated: false },
      { task: "find it" }
    );
    const data = result.data as { note: string; helperModel: string; report: string };
    expect(data.helperModel).toBe("free/wide");
    expect(data.report).toBe("found it");
    expect(data.note).toBe(DELEGATE_CLAIM_CAVEAT);
    expect(data.note).toMatch(/lead, not as evidence/);
    expect(result.summary).toContain("free/wide");
  });
});
