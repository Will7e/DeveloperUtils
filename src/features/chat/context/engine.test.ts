// ============================================================
// Context Engine — Window Attribution Tests
// ============================================================
// The breakdown is what the meter renders and what compaction is
// decided on, so its invariants are pinned here: the parts must sum
// to the window, the summary must never be double-counted as both
// system and memory, tool schemas must be charged, and the exact
// provider numbers must survive into the breakdown.

import { describe, it, expect } from "vitest";
import { computeBudget } from "./budget";
import { composeSystemPrompt, getConversationContext, prepareRequest } from "./engine";
import { estimateTokens, estimateToolSchemaTokens } from "./tokenizer";
import { PLAN_MODE_TOOLS, AGENT_TOOLS } from "../lib/tool-registry";
import type {
  ChatConversation,
  ChatMessage,
  ContextPart,
  ModelInfo,
  ToolDefinition,
} from "../types";

const MODEL: ModelInfo = {
  id: "test/model",
  name: "Test Model",
  contextLength: 100_000,
};

function message(over: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    content: "",
    timestamp: 0,
    ...over,
  };
}

function conversation(over: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "c1",
    title: "t",
    messages: [message({ role: "user", content: "hello there" })],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function tokensOf(parts: ContextPart[], key: ContextPart["key"]): number {
  return parts.find((p) => p.key === key)?.tokens ?? 0;
}

describe("estimateToolSchemaTokens", () => {
  it("is zero without tools", () => {
    expect(estimateToolSchemaTokens(undefined)).toBe(0);
    expect(estimateToolSchemaTokens([])).toBe(0);
  });

  it("charges for the whole surface and grows with it", () => {
    const lean = estimateToolSchemaTokens(PLAN_MODE_TOOLS);
    const full = estimateToolSchemaTokens(AGENT_TOOLS);
    expect(lean).toBeGreaterThan(100);
    expect(full).toBeGreaterThan(lean);
  });

  it("memoizes per array identity", () => {
    const tools: ToolDefinition[] = PLAN_MODE_TOOLS.slice(0, 3);
    expect(estimateToolSchemaTokens(tools)).toBe(estimateToolSchemaTokens(tools));
  });
});

describe("computeBudget", () => {
  it("reserves the output and subtracts system + tools", () => {
    const bare = computeBudget({ model: MODEL, systemPrompt: "hello" });
    const withTools = computeBudget({
      model: MODEL,
      systemPrompt: "hello",
      tools: AGENT_TOOLS,
    });

    expect(bare.toolTokens).toBe(0);
    expect(withTools.toolTokens).toBeGreaterThan(0);
    expect(withTools.available).toBe(bare.available - withTools.toolTokens);
  });

  it("falls back to a conservative window for unknown models", () => {
    const budget = computeBudget({ systemPrompt: "" });
    expect(budget.window).toBe(128_000);
  });
});

describe("getConversationContext", () => {
  it("attributes the whole window: spend parts + free space", () => {
    const info = getConversationContext({
      conversation: conversation(),
      model: MODEL,
      effectiveSystemPrompt: "You are a careful engineer.",
    });

    const sum = info.parts.reduce((n, p) => n + p.tokens, 0);
    expect(sum).toBe(info.usableTokens);
    expect(info.usableTokens + info.outputReserve).toBe(info.maxTokens);
    expect(info.parts[info.parts.length - 1]!.key).toBe("free");
  });

  it("charges tool schemas and shrinks the free space accordingly", () => {
    const params = {
      conversation: conversation(),
      model: MODEL,
      effectiveSystemPrompt: "system",
    };
    const without = getConversationContext(params);
    const withTools = getConversationContext({ ...params, tools: AGENT_TOOLS });

    expect(tokensOf(without.parts, "tools")).toBe(0);
    expect(tokensOf(withTools.parts, "tools")).toBeGreaterThan(0);
    expect(withTools.totalTokens).toBeGreaterThan(without.totalTokens);
    expect(tokensOf(withTools.parts, "free")).toBeLessThan(
      tokensOf(without.parts, "free")
    );
  });

  it("omits empty spend categories rather than listing a zero row", () => {
    const info = getConversationContext({
      conversation: conversation(),
      model: MODEL,
      effectiveSystemPrompt: "system",
    });
    expect(info.parts.every((p) => p.tokens > 0)).toBe(true);
  });

  it("splits the rolling summary into memory instead of double-counting it", () => {
    const summary = {
      text: "The user is building a context meter for an OpenRouter chat client.",
      coversCount: 6,
      createdAt: 1,
      freedTokens: 4200,
    };
    const base = "You are a careful engineer.";
    const prompt = composeSystemPrompt(base, summary)!;

    const info = getConversationContext({
      conversation: conversation({ summary }),
      model: MODEL,
      effectiveSystemPrompt: prompt,
    });

    const system = tokensOf(info.parts, "system");
    const memory = tokensOf(info.parts, "memory");

    expect(memory).toBeGreaterThan(0);
    // System + memory is exactly the prompt estimate — nothing is
    // counted twice, nothing is lost.
    expect(system + memory).toBe(estimateTokens(prompt));
    expect(system).toBeLessThan(estimateTokens(prompt));
    expect(info.compactedTokens).toBe(4200);
  });

  it("does not invent memory when the prompt omits the summary", () => {
    const info = getConversationContext({
      conversation: conversation({
        summary: { text: "old stuff", coversCount: 2, createdAt: 1, freedTokens: 10 },
      }),
      model: MODEL,
      effectiveSystemPrompt: "You are a careful engineer.",
    });
    expect(tokensOf(info.parts, "memory")).toBe(0);
  });

  it("surfaces the exact prompt tokens, cache hits and spend of the last reply", () => {
    const info = getConversationContext({
      conversation: conversation({
        messages: [
          message({ role: "user", content: "hi" }),
          message({
            role: "assistant",
            content: "hello",
            usage: {
              promptTokens: 24_318,
              completionTokens: 890,
              cost: 0.004,
              cachedTokens: 18_240,
            },
          }),
          message({ role: "user", content: "again" }),
          message({
            role: "assistant",
            content: "sure",
            usage: {
              promptTokens: 30_100,
              completionTokens: 120,
              cost: 0.006,
              cachedTokens: 27_900,
            },
          }),
        ],
      }),
      model: MODEL,
      effectiveSystemPrompt: "system",
    });

    // Most recent exact frame wins
    expect(info.lastPromptTokens).toBe(30_100);
    expect(info.lastCachedTokens).toBe(27_900);
    // Totals accumulate across the conversation
    expect(info.totalCost).toBeCloseTo(0.01, 6);
    expect(info.completionTokens).toBe(1010);
  });

  it("reports no exact frame before the first reply", () => {
    const info = getConversationContext({
      conversation: conversation(),
      model: MODEL,
      effectiveSystemPrompt: "system",
    });
    expect(info.lastPromptTokens).toBeNull();
    expect(info.lastCachedTokens).toBeNull();
    expect(info.totalCost).toBe(0);
    // No samples recorded for the model in this test process
    expect(info.calibrated).toBe(false);
  });

  it("reports percentage against the usable window, not the raw one", () => {
    const info = getConversationContext({
      conversation: conversation(),
      model: MODEL,
      effectiveSystemPrompt: "system",
    });
    const expected = (info.totalTokens / info.usableTokens) * 100;
    expect(info.percentageUsed).toBeCloseTo(expected, 1);
    expect(info.percentageUsed).toBeLessThan(100);
  });

  it("reads the free space as window minus everything sent", () => {
    const info = getConversationContext({
      conversation: conversation(),
      model: MODEL,
      effectiveSystemPrompt: "system",
      tools: PLAN_MODE_TOOLS,
    });
    expect(tokensOf(info.parts, "free")).toBe(
      info.usableTokens - info.totalTokens
    );
  });
});

describe("prepareRequest", () => {
  it("budgets tool schemas into the request the same way the meter does", () => {
    const conv = conversation();
    const without = prepareRequest({
      conversation: conv,
      model: MODEL,
      effectiveSystemPrompt: "system",
    });
    const withTools = prepareRequest({
      conversation: conv,
      model: MODEL,
      effectiveSystemPrompt: "system",
      tools: AGENT_TOOLS,
    });

    expect(withTools.budget.toolTokens).toBeGreaterThan(0);
    expect(withTools.budget.available).toBeLessThan(without.budget.available);
  });

  it("does not mutate the conversation it reads", () => {
    const conv = conversation();
    const snapshot = JSON.stringify(conv);
    prepareRequest({
      conversation: conv,
      model: MODEL,
      effectiveSystemPrompt: "system",
      tools: AGENT_TOOLS,
    });
    expect(JSON.stringify(conv)).toBe(snapshot);
  });
});
