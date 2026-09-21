// ============================================================
// Slash Input — Pure Resolution Rules for "/" Drafts
// ============================================================
// One question, answered in exactly one place: *is this draft a
// command, an unknown command attempt, or an ordinary message?*
// Both entry paths (composer Enter, Send button / sendUserMessage)
// consult this, so a slash draft can never be shipped to a model by
// one path while the other treats it as a command.
//
// The rules, in order:
//   1. not a slash draft                  → message
//   2. token matches a command id         → command (arg = the rest)
//   3. token is an unambiguous id prefix  → command (menu-style
//      completion: "/comp" runs /compact — but only when ONE command
//      matches, so "/s" never guesses between /status and /skills)
//   4. token matches a command keyword    → command ("/ctx" → context)
//   5. token is a bare word and unknown   → unknown (the caller keeps
//      the draft and explains, never sends)
//   6. unknown token WITH arguments       → message ("/usr/bin/env is
//      broken" is a sentence, not a command)
//
// Dependency-free on purpose: the runner, the composer, and the menu
// all import it, so it must not drag in stores or services.

/** Minimal shape the resolver needs from the command registry */
export interface CommandSpec {
  id: string;
  /** Extra match terms (aliases the user might type) */
  keywords?: readonly string[];
}

export interface ParsedSlash {
  /** True when the trimmed draft starts with "/" */
  isSlash: boolean;
  /** First whitespace-delimited word after the slash, lowercased */
  token: string;
  /** Everything after the token, trimmed */
  arg: string;
}

export type SlashResolution =
  | { kind: "command"; id: string; arg: string }
  | { kind: "unknown"; token: string }
  | { kind: "message" };

/** Splits a draft into slash token + argument (pure, no allocation churn) */
export function parseSlashInput(text: string): ParsedSlash {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { isSlash: false, token: "", arg: "" };
  }
  const body = trimmed.slice(1);
  const spaceIdx = body.search(/\s/);
  if (spaceIdx === -1) {
    return { isSlash: true, token: body.toLowerCase(), arg: "" };
  }
  return {
    isSlash: true,
    token: body.slice(0, spaceIdx).toLowerCase(),
    arg: body.slice(spaceIdx + 1).trim(),
  };
}

/**
 * Resolves a draft against the registry. See the header for the rule
 * order; `specs` is the FULL registry (availability is a menu
 * concern, not a resolution concern — typing /stop outside a turn
 * must still reach the command so it can explain itself).
 */
export function resolveSlashInput(text: string, specs: readonly CommandSpec[]): SlashResolution {
  const parsed = parseSlashInput(text);
  if (!parsed.isSlash) return { kind: "message" };

  const { token, arg } = parsed;
  if (!token) return { kind: "unknown", token };

  const byId = specs.find((s) => s.id === token);
  if (byId) return { kind: "command", id: byId.id, arg };

  const byKeyword = specs.find((s) => s.keywords?.some((k) => k.toLowerCase() === token));
  if (byKeyword) return { kind: "command", id: byKeyword.id, arg };

  // Unambiguous prefix completion — the same choice the menu's
  // Enter key makes, so keyboard and mouse paths agree.
  const prefixed = specs.filter((s) => s.id.startsWith(token));
  if (prefixed.length === 1) return { kind: "command", id: prefixed[0]!.id, arg };

  // A token that carries arguments and matches nothing is treated as
  // prose (file paths, "/usr/bin/env", quotes) and sent normally.
  if (arg.length > 0) return { kind: "message" };

  return { kind: "unknown", token };
}

/** Ranks specs for the menu: exact id, id prefix, keyword, then text match */
export function rankCommandSpecs<T extends CommandSpec & { description: string }>(
  specs: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...specs];

  const scored: Array<{ spec: T; score: number }> = [];
  for (const spec of specs) {
    const id = spec.id.toLowerCase();
    const desc = spec.description.toLowerCase();
    let score = Number.POSITIVE_INFINITY;
    if (id === q) score = 0;
    else if (id.startsWith(q)) score = 1;
    else if (spec.keywords?.some((k) => k.toLowerCase().startsWith(q))) score = 2;
    else if (spec.keywords?.some((k) => k.toLowerCase().includes(q))) score = 3;
    else if (id.includes(q)) score = 4;
    else if (desc.includes(q)) score = 5;
    if (score !== Number.POSITIVE_INFINITY) scored.push({ spec, score });
  }
  // Stable within a score band (registry order = author intent).
  return scored.sort((a, b) => a.score - b.score).map((s) => s.spec);
}
