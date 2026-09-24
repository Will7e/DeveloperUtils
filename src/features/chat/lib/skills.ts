// ============================================================
// Skills Library — Injection, Import/Export, Reconciliation
// ============================================================
// A skill is a reusable prompt module. Enabled skills are
// appended to the system prompt as a stable markdown block so
// provider-side prompt caches keep hitting (the block only
// changes when the skill set itself changes).

import { generateId } from "@/lib/utils";
import { BUILTIN_SKILLS } from "../constants";
import type { ChatSkill } from "../types";

/**
 * Standing rule that turns the skill index into a discoverable library:
 * the body is fetched on demand instead of being paid for every turn.
 */
export const SKILL_INDEX_RULE =
  "Skills marked `load` are available but their instructions are NOT loaded yet — call " +
  "`read_skill` with the skill name before acting when the task matches (its triggers, or the " +
  "kind of work you are about to do). Loading two or three relevant skills up front is cheap " +
  "and makes the rest of the turn more accurate. Match on what the user MEANS, not only on the " +
  "words listed: \"it is still broken\", \"doesn't work\" and \"fix this\" match a debugging or " +
  "verification skill, and a failing build or a change about to be shipped is exactly when " +
  "loading one pays for itself. A skill whose instructions are ALREADY present because the " +
  "harness loaded it for this request needs no fetch — read the ones below the request only " +
  "when their triggers fit and their text is not already in front of you.";

/**
 * Builtins that have been REMOVED from the shipped set.
 *
 * Needed because `reconcileBuiltins` only ever ADDS: a skill deleted from
 * BUILTIN_SKILLS would otherwise live on in the settings modal of every user
 * who had already opened the app, which is everyone. Retiring is therefore a
 * two-part change — drop it from the shipped list, and name it here.
 */
export const RETIRED_BUILTIN_SKILL_IDS: readonly string[] = [
  "builtin-code-reviewer", // superseded by builtin-review-this-diff
  "builtin-commit-writer", // the push flow needs a conventional message anyway
  "builtin-test-writer", // superseded by builtin-add-tests-for-change
  "builtin-sql-explainer", // generic, not this product's loop
  "builtin-regex-debugger",
  "builtin-docs-simplifier",
  "builtin-api-designer",
];

/** The shipped builtins by id — the source of every default adopted below */
const SHIPPED_BY_ID = new Map(BUILTIN_SKILLS.map((s) => [s.id, s]));

/** One index line per loadable skill: name, description, triggers, globs */
export function buildSkillIndex(skills: ChatSkill[]): string | null {
  const loadable = skills
    .filter((s) => !s.enabled && s.content.trim())
    .sort((a, b) => a.id.localeCompare(b.id));
  if (loadable.length === 0) return null;

  const lines = loadable.map((s) => {
    const hints: string[] = [];
    // Hints are a recognition aid, not an exhaustive list: every trigger
    // shipped in the index is paid for on EVERY turn of EVERY
    // conversation, so show enough to recognise the skill and no more.
    if (s.triggers?.length) {
      hints.push(
        `triggers: ${s.triggers.slice(0, 5).join(", ")}${s.triggers.length > 5 ? ", …" : ""}`
      );
    }
    if (s.globs?.length) hints.push(`files: ${s.globs.slice(0, 3).join(", ")}`);
    const hintText = hints.length > 0 ? ` (${hints.join("; ")})` : "";
    const description = s.description ? ` — ${s.description}` : "";
    return `- \`load\` **${s.name}**${description}${hintText}`;
  });

  return [
    "# Available Skills",
    "",
    SKILL_INDEX_RULE,
    "",
    ...lines,
  ].join("\n");
}

/**
 * One skill's body as the prompt presents it.
 *
 * Shared by the cached "Active Skills" block and the per-turn auto-loaded
 * block so the two cannot drift: an always-on skill and a matched one should
 * read identically to the model, because they mean the same thing — follow me.
 */
export function renderSkillBody(skill: ChatSkill): string {
  return [
    `### Skill: ${skill.name}`,
    skill.description ? `_${skill.description}_` : "",
    skill.content.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the effective system prompt: base prompt + enabled skill bodies
 * + an index of the skills that are available to load on demand.
 *
 * The block is deterministic — enabled skills sorted by id, index sorted
 * by id — so the prompt prefix stays byte-stable across turns and
 * provider-side prompt caching keeps hitting. Nothing here may depend on
 * the current user message: a per-turn system prompt would invalidate the
 * cached prefix on every single turn.
 */
export function buildEffectiveSystemPrompt(
  basePrompt: string,
  skills: ChatSkill[],
  options: { includeIndex?: boolean } = {}
): string {
  const includeIndex = options.includeIndex ?? true;
  const enabled = skills
    .filter((s) => s.enabled && s.content.trim())
    .sort((a, b) => a.id.localeCompare(b.id));

  const sections = enabled.map(renderSkillBody);

  const blocks: string[] = [];
  if (sections.length > 0) {
    blocks.push(`# Active Skills\n\n${sections.join("\n\n")}`);
  }
  if (includeIndex) {
    const index = buildSkillIndex(skills);
    if (index) blocks.push(index);
  }

  const base = basePrompt.trim();
  if (blocks.length === 0) return base;
  const skillBlock = blocks.join("\n\n");
  return base ? `${base}\n\n${skillBlock}` : skillBlock;
}

/**
 * Finds a skill by id, exact name, or case-insensitive name — the
 * lookup `read_skill` uses so the model does not have to reproduce an
 * id perfectly.
 */
export function findSkill(skills: ChatSkill[], nameOrId: string): ChatSkill | undefined {
  const needle = nameOrId.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    skills.find((s) => s.id.toLowerCase() === needle) ??
    skills.find((s) => s.name.toLowerCase() === needle) ??
    skills.find((s) => s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === needle) ??
    skills.find((s) => s.name.toLowerCase().includes(needle)) ??
    undefined
  );
}

/**
 * True when a trigger appears in the text as a WORD or PHRASE.
 *
 * Substring matching was good enough while a match only produced a hint
 * ("this looks like the Add Tests skill"), where a false positive cost the
 * model one wasted read. It is not good enough now that a match LOADS A
 * SKILL BODY: `spec` matched "inspect", `push` matched "pushback", and each
 * would have injected several hundred tokens of the wrong instructions into
 * the turn. So the rule is a phrase match anchored to WORD EDGES, with the
 * common English suffixes allowed on the final word — "test" still finds
 * "tests" and "fail" finds "failing" — while "inspect" no longer finds
 * "spec".
 *
 * The anchors are lookarounds rather than `\b`: a trigger may START or END
 * with a non-word character, and `\b` needs a word character on the relevant
 * side. The shipped `.env` trigger is the proof — `\b\.env\b` cannot match
 * `.env` at all, so "compare these two .env files" would have silently
 * stopped loading the Compare Data skill.
 */
export function triggerMatches(text: string, trigger: string): boolean {
  const needle = trigger.trim().toLowerCase();
  if (!needle) return false;
  const words = needle
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return false;
  const pattern = words
    .map((w, i) => (i === words.length - 1 ? `${w}(?:s|es|ed|ing)?` : w))
    .join("\\s+");
  return new RegExp(`(?<!\\w)${pattern}(?!\\w)`, "i").test(text);
}

/**
 * Skills whose triggers or globs match a piece of text (the user's message,
 * or a file path). Used for discovery, for the turn log, and — through
 * `selectAutoSkills` — to decide which bodies load themselves.
 */
export function matchSkills(text: string, skills: ChatSkill[]): ChatSkill[] {
  if (!text.trim()) return [];
  return skills.filter((s) => {
    if (!s.content.trim()) return false;
    const triggers = s.triggers ?? [];
    const globs = s.globs ?? [];
    return (
      triggers.some((t) => triggerMatches(text, t)) ||
      globs.some((g) => globToRegExp(g).test(text))
    );
  });
}

/** How many skill bodies one turn may auto-load */
export const AUTO_SKILL_MAX = 2;
/** How many characters of skill body one turn may auto-load, in total */
export const AUTO_SKILL_CHAR_BUDGET = 6_000;

export interface AutoSkillSelection {
  /** Bodies to inject into this turn, in deterministic (id) order */
  loaded: ChatSkill[];
  /** Matched but over the cap or the budget — named, so `read_skill` can still pull them */
  deferred: ChatSkill[];
}

/**
 * The skills a request turns on by itself.
 *
 * This is the harness making the decision rather than asking the model to: the
 * triggers already answer "which skill does this look like", and a body the
 * model has to fetch before it can follow is a body it frequently never
 * fetches. Loading is capped twice — by count and by characters — because an
 * instruction budget is the scarcest thing a turn has, and a skill that
 * matches by accident must not be able to spend it. A body that alone exceeds
 * the budget is deferred rather than skipping the rest, so one oversized
 * skill cannot suppress a smaller, better match behind it.
 *
 * An `enabled` skill is excluded: it is already in the cached system prompt
 * on every turn, and injecting it again would pay for it twice.
 */
export function selectAutoSkills(
  text: string,
  skills: ChatSkill[],
  options: { max?: number; charBudget?: number } = {}
): AutoSkillSelection {
  const max = options.max ?? AUTO_SKILL_MAX;
  const budget = options.charBudget ?? AUTO_SKILL_CHAR_BUDGET;
  const matched = matchSkills(text, skills)
    .filter((s) => !s.enabled)
    .sort((a, b) => a.id.localeCompare(b.id));

  const loaded: ChatSkill[] = [];
  const deferred: ChatSkill[] = [];
  let used = 0;
  for (const skill of matched) {
    const size = skill.content.trim().length;
    if (loaded.length >= max || used + size > budget) {
      deferred.push(skill);
      continue;
    }
    loaded.push(skill);
    used += size;
  }
  return { loaded, deferred };
}

/**
 * Minimal glob → RegExp for repo paths: `**` spans directories
 * (`src/**\/*.tsx`), `*` stays within one path segment, `?` is one
 * character. Built in ONE pass on purpose — sequential string replaces
 * would re-escape the `*` inside the patterns they insert.
 */
export function globToRegExp(glob: string): RegExp {
  const RAW = glob.trim();
  const REGEX_SPECIAL = "\\^$+.()|{}[]";
  let out = "";
  for (let i = 0; i < RAW.length; i++) {
    const ch = RAW[i]!;
    if (ch === "*") {
      if (RAW[i + 1] === "*") {
        if (RAW[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += REGEX_SPECIAL.includes(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`, "i");
}

/** Skill file format: markdown body + YAML-ish frontmatter header */
export interface ParsedSkillFile {
  name: string;
  description: string;
  content: string;
  /** Comma-separated `triggers:` frontmatter, split and trimmed */
  triggers: string[];
  /** Comma-separated `globs:` frontmatter, split and trimmed */
  globs: string[];
}

/** "a, b ,c" → ["a","b","c"], dropping empties and capping length */
function parseListField(value: string | undefined, max = 12): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parses a skill file (`.md` with `name`/`description` frontmatter).
 * Throws with a helpful message on malformed input.
 */
export function parseSkillFile(raw: string): ParsedSkillFile {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    // No frontmatter: first line becomes the name, rest is content
    const lines = raw.trim().split("\n");
    if (lines.length === 0 || !lines[0]!.trim()) {
      throw new Error("Skill file is empty.");
    }
    return {
      name: lines[0]!.replace(/^#\s*/, "").trim().slice(0, 60),
      description: "",
      content: lines.slice(1).join("\n").trim(),
      triggers: [],
      globs: [],
    };
  }

  const [, header, body] = match;
  const meta: Record<string, string> = {};
  for (const line of header!.split("\n")) {
    const kv = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]!.trim().toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }

  const name = meta.name || "";
  if (!name) {
    throw new Error("Skill file frontmatter must include a 'name' field.");
  }
  if (!body!.trim()) {
    throw new Error("Skill file has no content after the frontmatter.");
  }

  return {
    name: name.slice(0, 60),
    description: (meta.description || "").slice(0, 140),
    content: body!.trim(),
    triggers: parseListField(meta.triggers),
    globs: parseListField(meta.globs),
  };
}

/** Serializes a skill to the shareable markdown format */
export function serializeSkillFile(skill: ChatSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...(skill.triggers?.length ? [`triggers: ${skill.triggers.join(", ")}`] : []),
    ...(skill.globs?.length ? [`globs: ${skill.globs.join(", ")}`] : []),
    "---",
    "",
    skill.content,
    "",
  ].join("\n");
}

/** Triggers a download of a skill as a .md file */
export function downloadSkillFile(skill: ChatSkill): void {
  const blob = new Blob([serializeSkillFile(skill)], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${skill.name.toLowerCase().replace(/[^\w\d]+/g, "-") || "skill"}.skill.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Creates a store-ready skill from parsed file data */
export function skillFromParsed(parsed: ParsedSkillFile): ChatSkill {
  return {
    id: generateId(),
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    enabled: false,
    ...(parsed.triggers.length > 0 ? { triggers: parsed.triggers } : {}),
    ...(parsed.globs.length > 0 ? { globs: parsed.globs } : {}),
  };
}

/**
 * Reconciles the stored skill list with the shipped builtins:
 *  - adds any builtin missing locally (new version shipped one)
 *  - restores deleted builtins
 *  - removes RETIRED builtins the user never touched
 *  - adopts a CHANGED shipped default (enabled) for builtins they never touched
 *  - never touches edited builtins (`updated: true`) or user skills
 * Returns the same array reference when nothing changed.
 *
 * Retirement is deliberately narrow. A retired skill is removed only when
 * the user left it alone — not edited, and not ENABLED. Deleting something
 * a user explicitly switched on would be the harness overruling a choice
 * they made, which is a worse outcome than one stale index line; an edited
 * builtin is their text, and their text is never ours to delete.
 *
 * Promoting is narrow for the same reason, and it is the other half of the
 * same question: a skill the product decides everyone should have has to
 * reach the installs that already exist, or the decision only applies to
 * people who never used the app. `updated` is what makes that safe, and it
 * is a real signal rather than a guess — the store stamps it on ANY patch to
 * a builtin, including a plain toggle, so a user who switched a skill off
 * has it and a user who never saw the setting does not. A choice they made
 * survives; a default they never saw does not.
 */
export function reconcileBuiltins(stored: ChatSkill[] | undefined): ChatSkill[] | null {
  const list = Array.isArray(stored) ? stored : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  let changed = false;

  const next = list.filter((skill) => {
    if (!RETIRED_BUILTIN_SKILL_IDS.includes(skill.id)) return true;
    const touched = skill.builtin !== true || skill.updated === true || skill.enabled === true;
    if (touched) return true;
    changed = true;
    return false;
  });

  for (const builtin of BUILTIN_SKILLS) {
    const existing = byId.get(builtin.id);
    if (!existing) {
      next.push({ ...builtin });
      changed = true;
    }
  }

  // Adopt a changed shipped default, but only for a builtin the user has
  // never touched — see the note above: `updated !== true` means they never
  // opened a setting for it, so nothing of theirs is being overruled.
  for (let i = 0; i < next.length; i++) {
    const skill = next[i]!;
    if (skill.builtin !== true || skill.updated === true) continue;
    const shipped = SHIPPED_BY_ID.get(skill.id);
    if (!shipped || shipped.enabled === skill.enabled) continue;
    next[i] = { ...skill, enabled: shipped.enabled };
    changed = true;
  }

  // Same reference when nothing changed: the store treats that as "no write",
  // and a needless array identity is a needless persistence pass.
  return changed ? next : null;
}

/** Normalizes skills coming from a remote sync snapshot */
export function normalizeSkillsForSync(stored: unknown): ChatSkill[] {
  const list = Array.isArray(stored) ? (stored as ChatSkill[]) : [];
  const reconciled = reconcileBuiltins(list);
  const base = reconciled ?? list;
  // Defensive field-level filter: drop malformed entries from older clients
  return base.filter(
    (s) =>
      s &&
      typeof s.id === "string" &&
      typeof s.name === "string" &&
      typeof s.content === "string" &&
      typeof s.enabled === "boolean"
  );
}
