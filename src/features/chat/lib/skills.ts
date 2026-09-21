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
  "and makes the rest of the turn more accurate.";

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

  const sections = enabled.map(
    (s) =>
      `### Skill: ${s.name}\n${s.description ? `_${s.description}_\n` : ""}${s.content.trim()}`
  );

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
 * Skills whose triggers or globs match a piece of text (the user's
 * message, or a file path). Used for discovery and observability — a
 * match is surfaced in the turn log and offered to the model as a
 * suggestion, never injected behind its back.
 */
export function matchSkills(text: string, skills: ChatSkill[]): ChatSkill[] {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return [];
  return skills.filter((s) => {
    if (!s.content.trim()) return false;
    const triggers = s.triggers ?? [];
    const globs = s.globs ?? [];
    return (
      triggers.some((t) => t.trim() && haystack.includes(t.trim().toLowerCase())) ||
      globs.some((g) => globToRegExp(g).test(text))
    );
  });
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
 *  - never touches edited builtins (`updated: true`) or user skills
 * Returns the same array reference when nothing changed.
 */
export function reconcileBuiltins(stored: ChatSkill[] | undefined): ChatSkill[] | null {
  const list = Array.isArray(stored) ? stored : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  let changed = false;
  const next = [...list];

  for (const builtin of BUILTIN_SKILLS) {
    const existing = byId.get(builtin.id);
    if (!existing) {
      next.push({ ...builtin });
      changed = true;
    }
  }

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
