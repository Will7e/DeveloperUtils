// ============================================================
// Turn Prep — Shared Request Preparation (Page-Side)
// ============================================================
// Extracted from chat-runner so the host-dispatch path and the
// in-page fallback share one implementation of: model resolution,
// model state (reasoning effort), agent mode, compaction, system
// prompt composition, and wire-request preparation.
//
// Page-side only (touches stores and the context engine).
//
// There is no router here any more. A turn runs the model the user
// picked — the id in the payload IS the wire model — with the chosen
// reasoning rung snapped to that model's declared capabilities
// (lib/model-state.ts). Failover across providers stays OpenRouter's
// job; falling back to a *different model* silently is exactly the
// masking this replaced.

import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import { prepareRequest, composeSystemPrompt, getConversationContext, needsCompaction } from "../context/engine";
import { buildEffectiveSystemPrompt, matchSkills } from "../lib/skills";
import { logTurnEvent } from "../session/turn-log";
import { UNTRUSTED_RULE } from "../lib/untrusted";
import { VERIFICATION_LIMIT_NOTE } from "../lib/evidence-audit";
import { MEMORY_PATH, MEMORY_PROMPT_BLOCK } from "../lib/project-memory";
import { resolveToolProfile } from "../lib/tool-profiles";
import { modelSupportsTools, modelSupportsVision, resolveEffortState } from "../lib/model-state";
import { resolveModelInfo, ensureModelCatalog } from "../lib/model-catalog";
import { DEFAULT_CHAT_MODE, DEFAULT_REASONING_EFFORT } from "../constants";
import { ensureCompaction } from "./compaction";
import { visibleMessages } from "../types";
import type {
  ChatConversation,
  ChatMode,
  ModelInfo,
  ReasoningEffort,
  RepoContext,
} from "../types";
import type { HostCandidate } from "../session/protocol";

export interface PreparedTurn {
  /** Concrete wire model — always the model the user selected */
  modelId: string;
  /** Agent mode this turn runs under */
  mode: ChatMode;
  /** Reasoning rung the turn was sent with */
  effort: ReasoningEffort;
  systemPrompt: string;
  temperature: number;
  messages: unknown[];
  tools?: unknown[];
  /** Estimated tokens of the wire payload (usage calibration) */
  sentTokens: number;
  /** Model attempts for the host, in order (primary only today) */
  candidates: HostCandidate[];
}

/**
 * Turn preparation result: a ready turn, or null when the
 * conversation vanished / no API key (UI already handled).
 */
export type TurnPreparation = PreparedTurn | null;

/** Resolves the conversation's model state (override → settings → default) */
export function resolveModelState(conversation: ChatConversation | undefined): {
  model: string;
  effort: ReasoningEffort;
  mode: ChatMode;
} {
  const settings = useChatStore.getState().settings;
  return {
    model: conversation?.model ?? settings.defaultModel,
    effort: conversation?.reasoningEffort ?? settings.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
    mode: conversation?.mode ?? settings.defaultMode ?? DEFAULT_CHAT_MODE,
  };
}

/**
 * Resolves the candidate list for a turn. One candidate: the selected
 * model, carrying the request state its own catalog entry supports.
 * `toolsSupported: false` means the caller must send no tools at all —
 * strict providers reject tools on models that cannot call them.
 */
export function resolveCandidates(params: {
  requestedModel: string;
  effort: ReasoningEffort;
  /** Turn will carry tool definitions (repo attached + token present) */
  needsTools?: boolean;
}): { toolsSupported: boolean; candidates: HostCandidate[] } {
  const { requestedModel, effort, needsTools = false } = params;
  const info: ModelInfo | undefined = resolveModelInfo(requestedModel);
  return {
    toolsSupported: !needsTools || modelSupportsTools(info),
    candidates: [
      {
        modelId: requestedModel,
        contextLength: info?.contextLength,
        requestState: resolveEffortState(effort, info),
      },
    ],
  };
}

/** Warns once per conversation when the selected model cannot call tools */
const warnedToolsIssues = new Set<string>();

function warnToolsUnavailable(key: string, message: string): void {
  if (warnedToolsIssues.has(key)) return;
  warnedToolsIssues.add(key);
  useAppStore.getState().addToast({ message, type: "error", duration: 5000 });
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

  const { model: requestedModel, effort, mode } = resolveModelState(conversation);

  // Tool definitions only ride turns that have a repo AND a token to
  // reach it; plan mode narrows the set to the read-only subset.
  const needsTools = Boolean(conversation.repoContext && settings.github.token);
  const resolved = resolveCandidates({ requestedModel, effort, needsTools });
  const toolsAllowed = resolved.toolsSupported;

  if (needsTools && !toolsAllowed) {
    warnToolsUnavailable(
      requestedModel,
      `Model \`${requestedModel}\` does not support tool calling — repository tools are disabled for this turn. Pick a tool-capable model to edit code.`
    );
  }

  // Compose the base prompt + enabled skills into one system prompt
  const basePrompt =
    conversation.systemPrompt?.trim() || settings.systemPrompt.trim() || "";
  const composedPrompt = buildEffectiveSystemPrompt(basePrompt, settings.skills ?? []);

  // Compact before the request when the budget demands it
  const modelInfo = resolveModelInfo(requestedModel);
  const contextNow = getConversationContext({
    conversation,
    model: modelInfo,
    effectiveSystemPrompt: composedPrompt,
    modelId: requestedModel,
  });
  if (needsCompaction(contextNow)) {
    await ensureCompaction(conversationId);
  }

  // Re-read post-compaction state (messages may have been folded)
  const live = useChatStore.getState().conversations.find((c) => c.id === conversationId);
  if (!live) return null;

  const repoContext = live.repoContext;
  const agentActive = Boolean(repoContext && settings.github.token) && toolsAllowed;
  // The tool surface is matched to the model the catalog describes: a
  // weak or small-window model gets the lean set instead of fifteen
  // schemas it will misuse. Plan mode narrows inside the profile, so a
  // profile can never re-introduce a mutating tool.
  const profile = agentActive ? resolveToolProfile(mode, modelInfo) : null;
  const tools = profile ? profile.tools : undefined;

  // The rolling summary rides in the system block (deterministic
  // placement keeps provider-side prompt caches hitting). The repo
  // block sits after it so both stay stable across turns.
  const baseSystemPrompt =
    agentActive && repoContext
      ? [composeSystemPrompt(composedPrompt, live.summary), composeRepoPrompt(repoContext)]
          .filter(Boolean)
          .join("\n\n")
      : (composeSystemPrompt(composedPrompt, live.summary) ?? "");

  const planBlock = mode === "plan" ? composePlanPrompt() : "";
  const effectiveSystemPrompt = [baseSystemPrompt, profile?.note, planBlock]
    .filter(Boolean)
    .join("\n\n");

  // Skill discovery signal. A skill whose triggers match the user's
  // current message is the one worth loading, so record the match in
  // the turn log — the instruction block itself must stay byte-stable
  // across turns (a per-turn system prompt would break provider-side
  // prompt caching for the whole conversation prefix).
  const lastUser = [...visibleMessages(live.messages)].reverse().find((m) => m.role === "user");
  if (lastUser?.content && agentActive) {
    const matched = matchSkills(lastUser.content, settings.skills ?? []).filter((s) => !s.enabled);
    if (matched.length > 0) {
      logTurnEvent({
        turnId: null,
        conversationId,
        phase: "turn-start",
        detail: `skill triggers matched (loadable): ${matched.map((s) => s.name).join(", ")}`,
      });
    }
  }

  const prepared = prepareRequest({
    conversation: live,
    model: modelInfo,
    effectiveSystemPrompt,
    modelId: requestedModel,
  });

  // Warm the live catalog in the background (model picker + effort state)
  void ensureModelCatalog(apiKey);

  return {
    modelId: requestedModel,
    mode,
    effort,
    systemPrompt: effectiveSystemPrompt,
    temperature: settings.temperature,
    messages: prepared.messages as unknown[],
    tools: tools as unknown[] | undefined,
    sentTokens: prepared.sentTokens,
    candidates: resolved.candidates,
  };
}

/** Repo-context block (shared with the runner's in-page path) */
export function composeRepoPrompt(repo: RepoContext): string {
  return [
    `# Repository Context`,
    ``,
    `The user attached the GitHub repository **${repo.owner}/${repo.repo}** (branch: \`${repo.branch}\`) to this conversation.`,
    `Repository tools:`,
    `- get_repo_overview: start here for unfamiliar repos — root structure + README excerpt`,
    `- list_repo_files: list the file tree (optionally narrowed to a subtree)`,
    `- read_file: read a file (pass startLine/endLine to window a large one)`,
    `- search_code: full-text search on GitHub (default branch only, rate-limited, cannot see your edits)`,
    `- search_workspace: substring/regex search over your working copy, including edits you just made`,
    `- run_tool_program: batch up to 8 of the READ-ONLY calls above into ONE call (e.g. read three files, or search then read the hits). Use it instead of 3+ separate calls — it is much faster and cheaper.`,
    ``,
    `You have write/verify tools that edit only the local agent workspace (never GitHub directly):`,
    `- edit_file: replace an exact string in an existing file — the DEFAULT way to change code`,
    `- write_file: create a new file, or fully rewrite one you have read in its entirety`,
    `- delete_file: remove a file`,
    `- get_workspace_diff: the diff of everything you have changed so far (your record of the change set)`,
    `- run_in_preview: execute JavaScript inside the built preview app to verify runtime behavior`,
    `- query_preview_dom: query the preview's rendered DOM with a CSS selector to verify UI output`,
    `- get_preview_feedback: read build errors + console output from the preview`,
    `- create_working_branch / push_changes: ship the workspace diff to GitHub as one commit (+ optional PR) after user approval`,
    `- remember: record one durable, repo-specific fact in ${MEMORY_PATH} so later sessions stop rediscovering it`,
    `- read_skill: load the full instructions of an available skill by name (see the skill index above)`,
    `- delegate: hand a research task to a read-only helper agent that returns only a report — use it when searching would flood your context with file contents you do not need`,
    ``,
    `Guidelines:`,
    `- Prefer tools over guessing. Ground every claim about the codebase in files you actually read.`,
    `- Use list_repo_files/search_workspace to locate relevant files, then read_file only what you need.`,
    `- When exploring several files or running several searches, emit one run_tool_program with the batched steps instead of many separate calls.`,
    `- To change an existing file: read the region first, then use edit_file with the exact text and enough surrounding context to be unique. Never rewrite a file wholesale from a truncated or partially-read view — you would destroy everything you did not see.`,
    `- write_file and edit_file run one at a time, so each sees the previous write's result.`,
    `- After edits, close the loop: edit → (preview rebuilds) → run_in_preview or query_preview_dom to verify, and get_preview_feedback for build/console errors. Fix and re-verify before pushing.`,
    `- Before push_changes, call get_workspace_diff to review the complete change set.`,
    `- Cite file paths when referencing code.`,
    `- Answer from the repository, not from assumptions about similar projects.`,
    `- A push request reaches a human approver; if push_changes returns rejected, adapt to their note instead of retrying unchanged.`,
    ``,
    VERIFICATION_LIMIT_NOTE,
    ``,
    UNTRUSTED_RULE,
    ``,
    MEMORY_PROMPT_BLOCK,
  ].join("\n");
}

/**
 * Plan-mode directive. Plan mode withholds every mutating tool, so the
 * only honest framing is "propose, don't apply": the model investigates
 * read-only and hands back a plan the user can act on (usually by
 * switching to Build mode).
 */
export function composePlanPrompt(): string {
  return [
    `# Plan Mode`,
    ``,
    `You are in PLAN MODE. Writing tools (write_file, edit_file, delete_file,`,
    `create_working_branch, push_changes) are NOT available to you this turn,`,
    `so do not attempt them and do not claim to have made changes.`,
    ``,
    `Instead:`,
    `1. Investigate with the read-only tools until you can be specific about real files, symbols, and line ranges.`,
    `2. Produce a concrete plan — ordered steps, the exact files involved, and the risk or open question attached to each step.`,
    `3. Call out anything you could not verify from the code, and what you would need to check first.`,
    `4. End by asking the user to switch to Build mode to apply the plan, or by answering their question if they only wanted analysis.`,
  ].join("\n");
}

/** Vision capability of a conversation's resolved model (null = unknown) */
export function conversationSupportsVision(conversationId: string): boolean | null {
  const conversation = useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId);
  const { model } = resolveModelState(conversation);
  const info = resolveModelInfo(model);
  if (!info?.inputModalities) return null;
  return modelSupportsVision(info);
}
