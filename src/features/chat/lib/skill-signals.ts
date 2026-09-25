// ============================================================
// Skill Signals — Skills Triggered By The Environment, Not Just Words
// ============================================================
// `selectAutoSkills` (skills.ts) matches the USER'S MESSAGE, once per
// turn. But turn prep runs once per ROUND, and by round three the most
// informative text in the conversation is not what the user typed — it
// is what just happened: the check that failed against the current
// code, the paths the agent changed, the exception the running app
// threw. A skill whose triggers name that situation should load at that
// moment, not sit in the index while the model rediscovers its
// procedure by trial and error.
//
// The harness already pays for this decision point: prepareTurn
// recomputes the turn note every round, and the verification ledger,
// the workspace change set and the preview bridge already hold the
// facts. This module turns those facts into matching text and selects
// skills against it, under the SAME caps as the user-message path
// (count and character budget) so an instruction budget cannot be
// doubled by matching twice.
//
// Priority is load-bearing and asymmetric on purpose:
//
//   1. user-message matches  — what the request asked for
//   2. environment matches   — what the turn is living through
//
// User matches keep their slots even when the environment match is
// stronger, because the user asked for it; environment matches fill
// what is LEFT. An `enabled` skill is excluded from both — it is
// already in the cached system prompt, and injecting it again would
// pay for it twice (the same rule `selectAutoSkills` applies).
//
// One more rule exists because round prep REPEATS: a body once injected
// this turn must not be injected again on round three. Deduping lives
// in `skill-signals.ts` (the caller passes what was already sent) so
// the selection stays pure; the caller's memory of "already sent" is
// cleared by the turn's own lifecycle, never by this module.

import type { ChatSkill } from "../types";
import {
  AUTO_SKILL_CHAR_BUDGET,
  AUTO_SKILL_MAX,
  globToRegExp,
  matchSkills,
  renderSkillBody,
} from "./skills";

/**
 * The facts of one round, as matching text.
 *
 * Everything is OPTIONAL and empty means silent: a conversation with no
 * repository attached contributes no changed paths, and a turn with no
 * verification evidence contributes no failing checks. The signal text
 * is built to be MATCHED (trigger and glob regexes run against it), not
 * to be read by the model — nothing here is sent anywhere by itself.
 */
export interface EnvironmentSignals {
  /**
   * One entry per fresh-failing check: the ledger's summary line and
   * its first failure details ("`npm test` exited 1 — 3 failed, …").
   */
  failingChecks: string[];
  /** Paths in the current change set (skill `globs` finally match real paths) */
  changedPaths: string[];
  /** Fresh uncaught errors from the running preview (one line each) */
  previewErrors: string[];
}

/**
 * Renders the environment signals as the text skill matching runs on.
 *
 * Each signal class gets its own line so a trigger like "npm test" or
 * "typecheck" finds the fact that carries it, and file paths land on
 * their own lines so `globs` anchored with `^…$` can match them whole.
 */
export function renderEnvironmentSignals(signals: EnvironmentSignals): string {
  const lines: string[] = [];
  for (const check of signals.failingChecks) {
    lines.push(`failing check: ${check}`);
  }
  // Changed paths render independently of the checks: a skill matched by
  // `globs` ("*.test.ts" — a test-writing skill) should fire on the change
  // set alone, not only when something is already red.
  if (signals.changedPaths.length > 0) {
    lines.push("changed files:");
    for (const path of signals.changedPaths) lines.push(`  ${path}`);
  }
  for (const error of signals.previewErrors) {
    lines.push(`runtime error: ${error}`);
  }
  return lines.join("\n");
}

export interface SignalSkillSelection {
  /** Bodies to inject into this round, in injection order */
  loaded: ChatSkill[];
  /** Matched but over the caps — named, so `read_skill` can still pull them */
  deferred: ChatSkill[];
  /** Names already injected on an EARLIER round of this turn */
  alreadyActive: string[];
}

export interface SignalSelectionOptions {
  max?: number;
  charBudget?: number;
}

/**
 * Selects skills for one round from the user's message AND the
 * environment, with user matches keeping priority.
 *
 * `priorLoaded` carries the names of bodies injected on earlier rounds
 * of this turn: a skill there is reported in `alreadyActive` (the turn
 * note can say "already in force" instead of re-paying its body) and is
 * excluded from the fresh budget. Passing nothing degenerates to a
 * two-source version of `selectAutoSkills`.
 */
export function selectAutoSkillsFromSignals(
  userText: string,
  environmentText: string,
  skills: ChatSkill[],
  priorLoaded: readonly string[] = [],
  options: SignalSelectionOptions & {
    /** Changed paths, matched individually against skill `globs` */
    environmentPaths?: readonly string[];
  } = {}
): SignalSkillSelection {
  const max = options.max ?? AUTO_SKILL_MAX;
  const budget = options.charBudget ?? AUTO_SKILL_CHAR_BUDGET;
  const prior = new Set(priorLoaded.map((n) => n.trim()).filter(Boolean));
  const environmentPaths = options.environmentPaths ?? [];

  // `matchSkills` is the single matcher for both text sources — trigger
  // word-edges and glob semantics cannot drift between the two paths
  // because there is only one implementation. Paths are matched ONE PER
  // PATH with the same `globToRegExp` the skill carries: the glob regexes
  // are `^…$` anchored, so a whole-list blob never matches, and one
  // matching path is enough to fire a `globs` skill.
  const userMatched = userText.trim() ? matchSkills(userText, skills) : [];
  const envTextMatched = environmentText.trim() ? matchSkills(environmentText, skills) : [];
  const envMatched = [...envTextMatched];
  for (const path of environmentPaths) {
    for (const skill of skills) {
      if (skill.enabled || !skill.content.trim()) continue;
      if (envMatched.includes(skill)) continue;
      if ((skill.globs ?? []).some((g) => globToRegExp(g).test(path))) {
        envMatched.push(skill);
      }
    }
  }

  const loaded: ChatSkill[] = [];
  const deferred: ChatSkill[] = [];
  let used = 0;

  const admit = (skill: ChatSkill): boolean => {
    const size = skill.content.trim().length;
    if (loaded.length >= max || used + size > budget) {
      deferred.push(skill);
      return false;
    }
    loaded.push(skill);
    used += size;
    return true;
  };

  // 1. User-message matches, in id order (the same determinism
  //    `selectAutoSkills` keeps — the note must not shuffle between rounds).
  for (const skill of [...userMatched].sort((a, b) => a.id.localeCompare(b.id))) {
    if (prior.has(skill.name) || skill.enabled) continue;
    admit(skill);
  }

  // 2. Environment matches fill what is left, skipping anything the user
  //    match already admitted or deferred — one skill, one verdict per round.
  const seen = new Set([...userMatched, ...deferred]);
  for (const skill of [...envMatched].sort((a, b) => a.id.localeCompare(b.id))) {
    if (prior.has(skill.name) || skill.enabled || seen.has(skill)) continue;
    admit(skill);
  }

  return { loaded, deferred, alreadyActive: [...prior] };
}

/**
 * Renders the skill bodies for the turn note, folding in the ones an
 * earlier round already injected.
 *
 * Fresh bodies render in full (they are instructions in force); prior
 * bodies are named, not repeated — the model has their text in the
 * transcript already, and paying for them again per round is exactly
 * the cost this module exists to avoid.
 */
export function renderSignalSkillBlock(selection: SignalSkillSelection): string {
  const lines: string[] = [];
  if (selection.loaded.length > 0) {
    lines.push(
      "The skill instructions below matched this request or the turn's current state and are ALREADY ACTIVE — follow them as part of the task.",
      ...selection.loaded.map(renderSkillBody)
    );
  }
  if (selection.alreadyActive.length > 0) {
    lines.push(
      `Also still in force from earlier in this turn: ${selection.alreadyActive.join(", ")} (loaded above — do not re-load).`
    );
  }
  return lines.filter(Boolean).join("\n");
}
