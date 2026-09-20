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
 * Builds the effective system prompt: base prompt + enabled skills.
 * The skills block is deterministic (sorted by id) for cache stability.
 */
export function buildEffectiveSystemPrompt(
  basePrompt: string,
  skills: ChatSkill[]
): string {
  const enabled = skills
    .filter((s) => s.enabled && s.content.trim())
    .sort((a, b) => a.id.localeCompare(b.id));

  if (enabled.length === 0) {
    return basePrompt.trim();
  }

  const sections = enabled
    .map(
      (s) =>
        `### Skill: ${s.name}\n${s.description ? `_${s.description}_\n` : ""}${s.content.trim()}`
    )
    .join("\n\n");

  const base = basePrompt.trim();
  const skillsBlock = `# Active Skills\n\n${sections}`;
  return base ? `${base}\n\n${skillsBlock}` : skillsBlock;
}

/** Skill file format: markdown body + YAML-ish frontmatter header */
export interface ParsedSkillFile {
  name: string;
  description: string;
  content: string;
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
  };
}

/** Serializes a skill to the shareable markdown format */
export function serializeSkillFile(skill: ChatSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
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
