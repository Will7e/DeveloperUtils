// ============================================================
// Turn Prep — Shared Request Preparation (Page-Side)
// ============================================================
// Extracted from chat-runner so the host-dispatch path and the
// in-page fallback share one implementation of: model resolution,
// turn classification, compaction, system-prompt composition, and
// wire-request preparation.
//
// Page-side only (touches stores, localStorage-backed learning
// router, and the context engine).

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { prepareRequest, composeSystemPrompt, getConversationContext, needsCompaction } from "../context/engine";
import { buildEffectiveSystemPrompt } from "../lib/skills";
import { AGENT_TOOLS } from "../lib/tools";
import {
  classifyTurn,
} from "../lib/intab-classify";
import {
  isIntabModel,
  getLastRouting,
  pickInTabModel,
  rankInTabCandidates,
  isModelDailyCapCooling,
  snapRequestStateForModel,
} from "../lib/intab-llm";
import { resolveModelInfo, ensureModelCatalog } from "../lib/model-catalog";
import { ensureCompaction } from "./compaction";
import { visibleMessages } from "../types";
import type {
  ChatConversation,
  ChatSettings,
  RepoContext,
} from "../types";
import type { HostCandidate } from "../session/protocol";
import type { TurnKind } from "../lib/intab-classify";

export interface PreparedTurn {
  /** Concrete wire model (or the InTab primary pick) */
  modelId: string;
  turnKind: TurnKind;
  /** True when this turn routes through the InTab virtual model */
  intab: boolean;
  needsVision: boolean;
  ranked: HostCandidate[];
  systemPrompt: string;
  temperature: number;
  messages: unknown[];
  tools?: unknown[];
  /** Estimated tokens of the wire payload (usage calibration) */
  sentTokens: number;
}

/**
 * Turn preparation result: a ready turn, the literal "exhausted"
 * signal (InTab pool empty before starting), or null when the
 * conversation vanished / no API key (UI already handled).
 */
export type TurnPreparation = PreparedTurn | "exhausted" | null;

/** Resolves the ranked candidate list for a turn (InTab-aware) */
export function resolveCandidates(params: {
  conversation: ChatConversation;
  requestedModel: string;
  exclude?: Set<string>;
}): {
  intab: boolean;
  turnKind: TurnKind;
  needsVision: boolean;
  candidates: HostCandidate[];
} {
  const { conversation, requestedModel, exclude } = params;
  const intab = isIntabModel(requestedModel);

  let turnKind: TurnKind = "analysis";
  const lastUser = [...visibleMessages(conversation.messages)]
    .reverse()
    .find((m) => m.role === "user" && !m.toolResult);
  const needsVision = visibleMessages(conversation.messages).some(
    (m) => m.role === "user" && (m.attachments ?? []).some((a) => a.dataUrl)
  );

  if (intab) {
    turnKind = classifyTurn({
      lastUserMessage: lastUser,
      messages: conversation.messages,
      hasRepo: Boolean(conversation.repoContext),
    });
  }

  if (!intab) {
    const info = resolveModelInfo(requestedModel);
    return {
      intab,
      turnKind,
      needsVision,
      candidates: [
        { modelId: requestedModel, contextLength: info?.contextLength },
      ],
    };
  }

  // The requested synthetic id selects the tier (Light/High/Max);
  // the classifier's turn kind refines the order WITHIN the tier.
  const pick = pickInTabModel({
    conversationId: conversation.id,
    needsVision,
    exclude,
    turnKind,
    tierModelId: requestedModel,
  });
  if (!pick) {
    return { intab, turnKind, needsVision, candidates: [] };
  }
  turnKind = pick.turnKind;

  const ranked = rankInTabCandidates({
    conversationId: conversation.id,
    needsVision,
    exclude,
    turnKind,
    tierModelId: requestedModel,
    count: 6,
  });
  // Ensure the sticky pick leads the list even when the ranker's
  // ordering shifted (racing preference vs stickiness edge case).
  // Each candidate carries its capability-snapped request state
  // (tier desire → this model's declared OpenRouter knobs), which
  // the host merges per attempt — including after reroutes.
  const candidates: HostCandidate[] = [
    pick.modelId,
    ...ranked.filter((m) => m.id !== pick.modelId).map((m) => m.id),
  ].map((modelId) => {
    const info = resolveModelInfo(modelId);
    return {
      modelId,
      contextLength: info?.contextLength,
      requestState: snapRequestStateForModel(requestedModel, info),
    };
  });
  return { intab, turnKind, needsVision, candidates };
}

/** True when this conversation would route through the InTab virtual model */
export function isIntabConversation(conversationId: string): boolean {
  const state = useChatStore.getState();
  const conv = state.conversations.find((c) => c.id === conversationId);
  return isIntabModel(conv?.model ?? state.settings.defaultModel);
}

/**
 * Composes the effective system prompt + prepared wire request for
 * the conversation's CURRENT state. Called once per host round.
 */
export async function prepareTurn(conversationId: string): Promise<TurnPreparation> {
  const store = useChatStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  if (!conversation) return null;

  const settings = store.settings;
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) {
    useAppStore.getState().addToast({
      message: "Add your OpenRouter API key in Chat Settings to start chatting.",
      type: "error",
      duration: 4500,
    });
    store.setSettingsOpen(true);
    return null;
  }

  const requestedModel = conversation.model ?? settings.defaultModel;
  const resolved = resolveCandidates({ conversation, requestedModel });
  if (resolved.candidates.length === 0) {
    return "exhausted"; // pool empty before starting
  }

  // When the sticky model is demoted for daily-cap exhaustion,
  // compact BEFORE the attempt — a smaller payload beats a 429.
  if (resolved.intab) {
    const last = getLastRouting(conversationId);
    if (last && isModelDailyCapCooling(last.modelId)) {
      await ensureCompaction(conversationId).catch(() => {});
    }
  }

  // Compose the base prompt + enabled skills into one system prompt
  const basePrompt =
    conversation.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
  const composedPrompt = buildEffectiveSystemPrompt(basePrompt, settings.skills ?? []);

  // Compact before the request when the budget demands it
  const modelInfo = resolveModelInfo(resolved.candidates[0]!.modelId);
  const contextNow = getConversationContext({
    conversation,
    model: modelInfo,
    effectiveSystemPrompt: composedPrompt,
    modelId: resolved.candidates[0]!.modelId,
  });
  if (needsCompaction(contextNow)) {
    await ensureCompaction(conversationId);
  }

  // Re-read post-compaction state (messages may have been folded)
  const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
  if (!live) return null;

  const repoContext = live.repoContext;
  const agentActive = Boolean(repoContext && settings.github.token);
  const tools = agentActive ? AGENT_TOOLS : undefined;

  // The rolling summary rides in the system block (deterministic
  // placement keeps provider-side prompt caches hitting). The repo
  // block sits after it so both stay stable across turns.
  const effectiveSystemPrompt =
    agentActive && repoContext
      ? [composeSystemPrompt(composedPrompt, live.summary), composeRepoPrompt(repoContext)]
          .filter(Boolean)
          .join("\n\n")
      : (composeSystemPrompt(composedPrompt, live.summary) ?? "");

  const prepared = prepareRequest({
    conversation: live,
    model: modelInfo,
    effectiveSystemPrompt,
    modelId: resolved.candidates[0]!.modelId,
  });

  // Warm the live catalog in the background (model picker + InTab pool)
  void ensureModelCatalog(apiKey);

  return {
    modelId: resolved.candidates[0]!.modelId,
    turnKind: resolved.turnKind,
    intab: resolved.intab,
    needsVision: resolved.needsVision,
    ranked: resolved.candidates,
    systemPrompt: effectiveSystemPrompt,
    temperature: settings.temperature,
    messages: prepared.messages as unknown[],
    tools: tools as unknown[] | undefined,
    sentTokens: prepared.sentTokens,
  };
}

/** Repo-context block (shared with chat-runner's in-page path) */
export function composeRepoPrompt(repo: RepoContext): string {
  return [
    `# Repository Context`,
    ``,
    `The user attached the GitHub repository **${repo.owner}/${repo.repo}** (branch: \`${repo.branch}\`) to this conversation.`,
    `You have read-only tools to explore it:`,
    `- get_repo_overview: start here for unfamiliar repos — root structure + README excerpt`,
    `- list_repo_files: list the file tree (optionally narrowed to a subtree)`,
    `- read_file: read one file's full content`,
    `- search_code: full-text search across the repo`,
    `- run_tool_program: batch up to 8 of the read-only calls above into ONE call (e.g. read three files, or search then read the hits). Use it instead of 3+ separate calls — it is much faster and cheaper.`,
    ``,
    `You have write/verify tools that edit only the local agent workspace (never GitHub directly):`,
    `- write_file / delete_file: edit workspace files; the live preview rebuilds automatically`,
    `- run_in_preview: execute JavaScript inside the built preview app to verify runtime behavior`,
    `- query_preview_dom: query the preview's rendered DOM with a CSS selector to verify UI output`,
    `- get_preview_feedback: read build errors + console output from the preview`,
    `- push_changes: ship the workspace diff to GitHub as one commit (+ optional PR) after user approval`,
    ``,
    `Guidelines:`,
    `- Prefer tools over guessing. Ground every claim about the codebase in files you actually read.`,
    `- Use list_repo_files/search_code to locate relevant files, then read_file only what you need.`,
    `- When exploring several files or running several searches, emit one run_tool_program with the batched steps instead of many separate calls.`,
    `- After edits, close the loop: write_file → (preview rebuilds) → run_in_preview or query_preview_dom to verify, and get_preview_feedback for build/console errors. Fix and re-verify before pushing.`,
    `- Cite file paths when referencing code.`,
    `- Answer from the repository, not from assumptions about similar projects.`,
  ].join("\n");
}
