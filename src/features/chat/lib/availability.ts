// ============================================================
// Availability — What Is Actually Live This Turn
// ============================================================
// Every capability this agent has can be absent: no repository is attached, no
// local companion is running, no web-search provider is configured, no MCP
// server answered, the selected model cannot call tools at all. Today the agent
// discovers each one the expensive way — it calls the tool, the tool explains
// itself, and the round is spent. Worse, a model that does not know a tool is
// unavailable plans around it and then apologizes.
//
// So the facts are collected BEFORE the turn and stated once, in the turn note,
// and the model is told the consequence rather than only the fact ("the
// companion is not running" is trivia; "a command cannot prove anything this
// turn, say so instead of retrying" is an instruction).
//
// Two sources, deliberately different in kind:
//
//   • DECLARED state, known synchronously (a repository is attached, N MCP
//     servers are configured, the model's catalog entry supports tools); and
//   • OBSERVED state, which starts "unknown" and is corrected by reality — a
//     companion probe, or a tool reporting that it could not run.
//
// Observed state starts unknown rather than assumed-up on purpose. Telling a
// model the companion is available when nobody has checked is how you get a
// confident "I verified that" about a command that never ran.
//
// Pure state + formatting; the probe is the caller's (turn-prep), and it never
// throws or blocks a turn for more than a moment.

import type { ModelInfo, RepoContext } from "../types";
import { modelSupportsTools, modelSupportsVision } from "./model-state";
import {
  COMPANION_UNPAIRED_HELP,
  companionCredentials,
  probeCompanion,
  type SavedCompanion,
} from "../companion/companion-client";
import { readWorkspaceEnvironment, workspaceVerdict } from "../container/boot-probe";

export type CapabilityState = "up" | "down" | "unknown";

/** Capabilities whose availability is learned by trying them */
export type ObservedCapability = "companion" | "webSearch" | "workspace";

interface CapabilityNote {
  state: CapabilityState;
  at: number;
}

const observed = new Map<ObservedCapability, CapabilityNote>();

/**
 * Why the companion was last down, in the words the model should repeat.
 *
 * Kept beside the state rather than derived from it, because "down" has three
 * different causes with three different fixes — unpaired, unreachable, wrong
 * protocol — and a model told only "down" invents a reason. The one that used
 * to be invented most was "the companion is not running" for a companion that
 * was running perfectly and simply had no token.
 */
let companionIssue: string | null = null;

/**
 * Why the browser workspace is not usable, when it is not.
 *
 * Same reasoning as the companion's: "down" has two unrelated causes with two
 * unrelated fixes — this page is not cross-origin isolated (a deployment
 * property nobody can fix from the app), or a runtime that was supported failed
 * to boot. A model told only "down" invents one of them.
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
 * interesting transitions (paired, then a command actually ran) happen exactly
 * when the user is watching.
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
 * that reports "no companion is running" is the most reliable probe there is.
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
  companionIssue = null;
  workspaceIssue = null;
  lastProbeAt = 0;
  notifyCapability();
}

let lastProbeAt = 0;
let probeInFlight: Promise<void> | null = null;

/**
 * Best-effort companion probe, at most once a minute.
 *
 * Never awaits longer than the probe's own timeout and never throws: a turn
 * must not fail because a local runner is not there. Concurrent callers share
 * one probe, so a burst of rounds does not open a socket each.
 *
 * `saved` is the pairing from settings. It is a PARAMETER rather than a store
 * read so this module stays testable without a browser, and so the one place
 * that knows the settings (turn prep) is the one place that passes them.
 */
export async function refreshCompanionAvailability(
  saved: SavedCompanion | null | undefined = null
): Promise<void> {
  if (Date.now() - lastProbeAt < OBSERVED_TTL_MS) return;
  if (probeInFlight) return probeInFlight;
  lastProbeAt = Date.now();
  probeInFlight = (async () => {
    try {
      const credentials = await companionCredentials(undefined, saved);
      if (!credentials.origin) {
        companionIssue = credentials.error ?? COMPANION_UNPAIRED_HELP;
        noteCapability("companion", "down");
        return;
      }
      if (!credentials.token) {
        // Reachable but unpaired is a DIFFERENT outcome from absent, and the
        // only one of the two the user can fix in two clicks.
        companionIssue = credentials.error;
        noteCapability("companion", "down");
        return;
      }
      const probe = await probeCompanion(credentials.origin);
      companionIssue = probe.available ? null : (probe.error ?? "the companion did not answer");
      noteCapability("companion", probe.available ? "up" : "down");
    } catch {
      // A probe that throws tells us nothing; leave the state as it was.
    } finally {
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

/** The last companion failure reason, or null when it is up / never probed */
export function companionDownReason(): string | null {
  return capabilityState("companion") === "down" ? companionIssue : null;
}

/**
 * Records an outcome learned by trying (set by the tools themselves, which is
 * the most reliable probe there is) — including its reason.
 */
export function noteCompanionOutcome(state: CapabilityState, reason?: string | null): void {
  if (reason !== undefined) companionIssue = state === "up" ? null : (reason ?? null);
  noteCapability("companion", state);
}

/**
 * Whether this PAGE can host a browser workspace at all.
 *
 * Declared, not observed, and therefore known before anything boots: it is the
 * document's own `crossOriginIsolated`, plus whether shared memory is exposed.
 * That is what separates this tier from the companion — no pairing, no probe,
 * no user step — so the answer is available at the start of the very first turn
 * rather than after a tool call has already failed.
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
  companion: CapabilityState;
  /**
   * Why the companion is unavailable, when it is. Present so the consequence
   * line can name the actual cause — unpaired, unreachable, or a protocol
   * mismatch are three fixes, and only one of them is "start the companion".
   */
  companionReason?: string | null;
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
    companion: capabilityState("companion"),
    companionReason: companionDownReason(),
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

  // The two execution tiers are described TOGETHER, because they are two answers
  // to one question ("can a command run this turn?") and the model's next move
  // depends on the pair, not on either fact alone. The line that used to be here
  // said `run_command` cannot run anything whenever the companion was down —
  // which stopped being true the moment this app could run a command in its own
  // tab, and would have made the model report a green run as UNVERIFIED.
  const workspaceReady = a.workspace !== "down";
  if (a.companion === "up") {
    facts.push("local companion running");
  } else if (a.companion === "down") {
    // The reason is stated, not implied. "NOT running" was wrong for the most
    // common case (a companion that is up but unpaired), and a model handed the
    // wrong cause writes the wrong fix into its reply and into the user's head.
    facts.push(a.companionReason ? `local companion unavailable — ${a.companionReason}` : "local companion NOT running");
  }

  if (a.workspace === "up") {
    facts.push("browser workspace running in this tab");
  } else if (a.workspace === "down") {
    facts.push(a.workspaceReason ? `browser workspace unavailable — ${a.workspaceReason}` : "browser workspace unavailable");
  } else if (workspaceReady) {
    facts.push("browser workspace available on this page (not started yet)");
  }

  if (a.companion === "down" && !workspaceReady) {
    consequences.push(
      "`run_command` cannot run anything this turn — a change you cannot execute is UNVERIFIED, so say that plainly instead of retrying the command"
    );
    consequences.push(
      "If the user asks how to make it work, tell them to open the app in a current desktop Chromium browser (commands then run in the browser tab itself), or pair a companion under Chat settings → Companion with `npm run companion`"
    );
  } else if (a.companion !== "up") {
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
