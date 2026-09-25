// ============================================================
// Availability — What Is Actually Live This Turn
// ============================================================
// Every capability this agent has can be absent: no repository is attached, no
// web-search provider is configured, no MCP server answered, the selected model
// cannot call tools at all. Today the agent discovers each one the expensive
// way — it calls the tool, the tool explains itself, and the round is spent.
// Worse, a model that does not know a tool is unavailable plans around it and
// then apologizes.
//
// So the facts are collected BEFORE the turn and stated once, in the turn note,
// and the model is told the consequence rather than only the fact ("the
// workspace cannot boot" is trivia; "a command cannot prove anything this
// turn, say so instead of retrying" is an instruction).
//
// Two sources, deliberately different in kind:
//
//   • DECLARED state, known synchronously (a repository is attached, N MCP
//     servers are configured, the model's catalog entry supports tools); and
//   • OBSERVED state, which starts "unknown" and is corrected by reality — a
//     boot probe, or a tool reporting that it could not run.
//
// Observed state starts unknown rather than assumed-up on purpose. Telling a
// model the workspace is available when nobody has checked is how you get a
// confident "I verified that" about a command that never ran.
//
// Pure state + formatting; the probe is the caller's (turn-prep), and it never
// throws or blocks a turn for more than a moment.

import type { ModelInfo, RepoContext } from "../types";
import { modelSupportsTools, modelSupportsVision } from "./model-state";
import { readWorkspaceEnvironment, workspaceVerdict } from "../container/boot-probe";

export type CapabilityState = "up" | "down" | "unknown";

/** Capabilities whose availability is learned by trying them */
export type ObservedCapability = "webSearch" | "workspace";

interface CapabilityNote {
  state: CapabilityState;
  at: number;
}

const observed = new Map<ObservedCapability, CapabilityNote>();

/**
 * Why the browser workspace is not usable, when it is not.
 *
 * "Down" has two unrelated causes with two unrelated fixes — this page is not
 * cross-origin isolated (a deployment property nobody can fix from the app),
 * or a runtime that was supported failed to boot. A model told only "down"
 * invents one of them, so the reason is kept beside the state.
 */
let workspaceIssue: string | null = null;

/** How long an observed state is trusted before it is re-probed */
const OBSERVED_TTL_MS = 60_000;

/**
 * Subscriptions over the observed state.
 *
 * The header chip reads these facts, and they change as a side effect of tools
 * running — so without a notification the chip would show whatever was true at
 * the last unrelated re-render. Polling would work and is the wrong shape: the
 * interesting transitions (a workspace booting, then a command actually ran)
 * happen exactly when the user is watching.
 */
const capabilityListeners = new Set<() => void>();
let capabilityRevision = 0;

export function subscribeCapability(listener: () => void): () => void {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

/** Monotonic revision of the observed-capability map, for snapshot comparison */
export function capabilityVersion(): number {
  return capabilityRevision;
}

function notifyCapability(): void {
  capabilityRevision += 1;
  for (const listener of capabilityListeners) {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the rest from learning the truth.
    }
  }
}

/**
 * Records what a capability just did. Called by the tools themselves: a run
 * that reports "the workspace could not boot" is the most reliable probe
 * there is.
 */
export function noteCapability(name: ObservedCapability, state: CapabilityState): void {
  if (state === "unknown") return;
  observed.set(name, { state, at: Date.now() });
  notifyCapability();
}

/** The last observed state, or "unknown" when nothing has been seen or it aged out */
export function capabilityState(name: ObservedCapability): CapabilityState {
  const note = observed.get(name);
  if (!note) return "unknown";
  if (Date.now() - note.at > OBSERVED_TTL_MS) return "unknown";
  return note.state;
}

/** Test seam: forget everything observed */
export function resetAvailability(): void {
  observed.clear();
  workspaceIssue = null;
  notifyCapability();
}

/**
 * Whether this PAGE can host a browser workspace at all.
 *
 * Declared, not observed, and therefore known before anything boots: it is the
 * document's own `crossOriginIsolated`, plus whether shared memory is exposed.
 * No pairing, no probe, no user step — so the answer is available at the start
 * of the very first turn rather than after a tool call has already failed.
 */
export function workspaceSupport(): { state: CapabilityState; reason: string | null } {
  const verdict = workspaceVerdict(readWorkspaceEnvironment());
  if (!verdict.supported) return { state: "down", reason: verdict.summary };
  const observedState = capabilityState("workspace");
  if (observedState === "down") return { state: "down", reason: workspaceIssue };
  return { state: observedState, reason: null };
}

/** The last workspace failure reason, or null while it is working / unobserved */
export function workspaceDownReason(): string | null {
  const support = workspaceSupport();
  return support.state === "down" ? support.reason : null;
}

/**
 * Records what the workspace just did. Called by the host and the executor: a
 * booted runtime is the only reliable proof that this page can host one.
 */
export function noteWorkspaceOutcome(state: CapabilityState, reason?: string | null): void {
  if (reason !== undefined) workspaceIssue = state === "up" ? null : (reason ?? null);
  noteCapability("workspace", state);
}

export interface TurnAvailability {
  /** Repository attached to this conversation, when there is one */
  repo: RepoContext | null;
  /**
   * Whether commands can run in THIS TAB, and whether that has been proven yet.
   * `unknown` here means "this page could host a workspace, nothing has booted
   * one" — which is why it is stated as a fact without a consequence.
   */
  workspace: CapabilityState;
  /** Why the workspace cannot run here, when it cannot */
  workspaceReason?: string | null;
  webSearch: CapabilityState;
  /** Configured MCP servers (declared state, not a probe) */
  mcpServers: number;
  /** Catalog capability of the selected model */
  toolCalling: boolean;
  vision: boolean;
}

/** Declared facts, straight from the settings and the catalog */
export function declaredAvailability(params: {
  repo: RepoContext | null;
  mcpServers: number;
  model: ModelInfo | undefined;
}): TurnAvailability {
  const workspace = workspaceSupport();
  return {
    repo: params.repo,
    workspace: workspace.state,
    workspaceReason: workspace.reason,
    webSearch: capabilityState("webSearch"),
    mcpServers: params.mcpServers,
    toolCalling: params.model ? modelSupportsTools(params.model) : true,
    vision: params.model ? modelSupportsVision(params.model) : true,
  };
}

/**
 * The turn's environment sentence, plus the consequence of anything that is
 * missing. Returns "" when everything is as expected — silence is the right
 * output for "nothing unusual here", because every line is paid for on every
 * turn.
 */
export function describeAvailability(a: TurnAvailability): string {
  const facts: string[] = [];
  const consequences: string[] = [];

  facts.push(a.repo ? `repository attached (${a.repo.owner}/${a.repo.repo}@${a.repo.branch})` : "no repository attached");

  // The one execution tier. Commands run in this tab or nowhere, so the
  // workspace's state IS the answer to "can a command run this turn?".
  const workspaceReady = a.workspace !== "down";
  if (a.workspace === "up") {
    facts.push("browser workspace running in this tab");
  } else if (a.workspace === "down") {
    // The reason is stated, not implied. "Unavailable" alone has two unrelated
    // causes with two unrelated fixes (a non-Chromium browser versus a failed
    // boot), and a model handed the wrong cause writes the wrong fix into its
    // reply and into the user's head.
    facts.push(a.workspaceReason ? `browser workspace unavailable — ${a.workspaceReason}` : "browser workspace unavailable");
  } else if (workspaceReady) {
    facts.push("browser workspace available on this page (not started yet)");
  }

  if (a.workspace === "down") {
    consequences.push(
      "`run_command` cannot run anything this turn — a change you cannot execute is UNVERIFIED, so say that plainly instead of retrying the command"
    );
    consequences.push(
      "If the user asks how to make it work, tell them to open the app in a current desktop Chromium browser (commands then run in the browser tab itself)"
    );
  } else {
    // Commands CAN run — in the tab. Say where, because it is a different
    // environment from the user's machine and a run's authority depends on it.
    consequences.push(
      "`run_command` runs in the browser workspace, not on the user's machine: cite it as the project's commands run in this tab, and do not present it as having run in their environment"
    );
  }

  if (a.webSearch === "down") {
    facts.push("web search not configured");
    consequences.push("`search_web` will report it is unavailable — ask the user for the URL instead of inventing one");
  } else if (a.webSearch === "up") {
    facts.push("web search available");
  }

  if (a.mcpServers > 0) facts.push(`${a.mcpServers} MCP server${a.mcpServers === 1 ? "" : "s"} configured`);

  if (!a.toolCalling) {
    facts.push("this model cannot call tools");
    consequences.push("no tools are available this turn: answer from what you know and say which parts you could not check");
  }

  const line = `Environment this turn: ${facts.join("; ")}.`;
  if (consequences.length === 0) return line;
  return `${line} ${consequences.map((c) => `${c}.`).join(" ")}`;
}
