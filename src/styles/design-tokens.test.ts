// ============================================================
// Geist Token Contract — Every Value Resolves, Every Colour Is a Token
// ============================================================
// The bug this file guards against is not an ugly colour. It is an ABSENT one.
//
// A declaration like `color: var(--text-3, #8b8b8b)` looks harmless — the
// fallback never fires while `--text-3` exists, so it survives review, survives
// a screenshot, and only reveals itself on the day the token is renamed or a
// light theme needs a different value. Then the surface silently freezes one
// theme's hex into both. Five live examples were still in chat.css when this
// test was written: `--emerald` (never existed → the Tailwind `#10b981` showed
// through), `--ds-font-mono` (→ `ui-monospace`, so tool output was the one code
// surface not in Geist Mono), `--ds-background-300` (→ `#222`, off-scale in
// dark and a black chip in light), `--text-4`, and `--transition-fast` with no
// fallback at all, which invalidated the whole `transition` shorthand.
//
// So the rules below are deliberately about RESOLUTION, not taste:
//
//   1. Every `var(--token)` in any stylesheet under src resolves — declared in
//      some CSS file, or set from TS/TSX for the browser to read at runtime.
//   2. The chat surface contains no raw colour literal. Colour reaches it
//      through the tiered tokens only (T1 `--ds-*` literals, T2 `--text-*` /
//      `--bg-*` semantics, T3 `--border-*`, T4 `--chat-*` components), which is
//      what makes one theme switch repaint it.
//   3. No `var(--token, fallback)` in the chat surface. This is the specific
//      shape that hid rules 1 and 2 — delete the fallback and a missing token
//      becomes a visible bug instead of a quiet hex.
//   4. `font-family`, `box-shadow` and `border-radius` name a token, so
//      elevation, type and corner rounding come from the ladder rather than
//      from whichever values the last change happened to type.
//
// The scan is line-oriented and reads the tree, on purpose: the finding has to
// name the file and the line, because the fix is always local.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/** Repo `src/` — the tool runs vitest from the repo root, this file sits one level in. */
const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The one surface held to the full contract. chat.css is 6k lines of a single
 * product surface; it earns the strict rules, and the rest of the app can be
 * migrated to them without blocking this guard. */
const STRICT_SURFACE = join("features", "chat", "chat.css");

/** Sub-token corner rounding that survives rule 4 on purpose: a 7–8px dot or a
 * 2px indicator bar rounds to a circle at `--radius-xs` (4px), which is a
 * different shape, not a different step of the same one. */
const MICRO_RADIUS = /^(?:[0-3]px|50%)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Blank out comments but keep every newline, so a match index still maps to the
 * line the author sees. Without this, `/* #0070f3 *​/` in a comment reads as a
 * hardcoded colour and the guard becomes noise.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** `--name:` — a declaration. A reference (`var(--name, x)`) has a comma, not a
 * colon, so this cannot double-count, and `-webkit-*` has no second dash. */
const DECLARATION = /--[a-z0-9-]+\s*:/g;
/** `var(--name)` / `var(--name, fallback)` — captures whether a fallback is present. */
const REFERENCE = /var\(\s*(--[a-z0-9-]+)\s*(,?)/g;
/** Tokens the browser reads but already has: `style={{ "--progress": p }}` and
 * `setProperty("--cursor-accent", c)`. Derived rather than allowlisted, so a new
 * runtime token needs no edit here — only a new *undeclared* one fails. */
const RUNTIME_TOKEN = /["'](--[a-z0-9-]+)["']\s*:|setProperty\(\s*["'](--[a-z0-9-]+)["']/g;
/** A colour written as a literal. `color-mix()` is absent on purpose: mixing
 * tokens is the endorsed way to derive a tint, and its arguments are checked by
 * the hex/function rule anyway. */
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\s*\(/gi;

/**
 * A Tailwind default-palette colour utility, e.g. `text-emerald-500`.
 *
 * This is the component-layer version of every rule above, and it is the one
 * that actually bit: `--emerald` was never a token, so `chat.css` carried
 * `color: var(--emerald, #10b981)` — Tailwind's emerald, pasted into the
 * stylesheet purely because a component had already reached for
 * `text-emerald-500` on the icon. One leak in TSX is what put a Tailwind hex in
 * the theme.
 *
 * The bare names are Geist tokens in this app's `@theme` (`text-green`,
 * `bg-red-dim` resolve to `--green`, `--red-dim`), so only the numbered scale is
 * a violation — and `white`/`black`, which no theme can repaint.
 */
const PALETTE_UTILITY =
  /\b(?:text|bg|border|ring|from|via|to|fill|stroke|decoration|divide|shadow|outline|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b|\b(?:text|bg|border|fill|stroke)-(?:white|black)\b/g;

/** Every string literal in a source file — `className`, `cn(...)`, template
 * holes. Classes are written in them, so this is where a palette utility would
 * hide. */
const STRING_LITERAL = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`]*)`/g;

/** `//` and `/* … *​/`, blanked with newlines kept so line numbers still map. A
 * comment that names a class in order to explain it is not a violation. */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));
}

const CSS_FILES = walk(SRC_ROOT).filter((file) => file.endsWith(".css"));
const SOURCE_FILES = walk(SRC_ROOT).filter((file) => /\.(?:ts|tsx)$/.test(file));

interface Finding {
  file: string;
  line: number;
  detail: string;
}

function report(findings: Finding[]): string {
  return findings
    .map((f) => `  ${relative(SRC_ROOT, f.file)}:${f.line} — ${f.detail}`)
    .join("\n");
}

/** Every `--token:` declared by any stylesheet, plus every token a TS/TSX file
 * hands the browser at runtime. */
const declared = new Set<string>();
for (const file of CSS_FILES) {
  for (const match of readFileSync(file, "utf8").matchAll(DECLARATION)) {
    declared.add(match[0].slice(0, -1).trim());
  }
}
for (const file of SOURCE_FILES) {
  for (const match of readFileSync(file, "utf8").matchAll(RUNTIME_TOKEN)) {
    const token = match[1] ?? match[2];
    if (token) declared.add(token.trim());
  }
}

describe("Geist token contract", () => {
  it("gives every var() a token that exists", () => {
    const findings: Finding[] = [];
    for (const file of CSS_FILES) {
      const css = stripComments(readFileSync(file, "utf8"));
      for (const match of css.matchAll(REFERENCE)) {
        const token = match[1];
        if (!token || declared.has(token)) continue;
        findings.push({
          file,
          line: lineOf(css, match.index),
          detail: `var(${token}) is not declared by any stylesheet and is not set at runtime`,
        });
      }
    }
    expect(findings, `Undefined design tokens:\n${report(findings)}`).toEqual([]);
  });

  describe("chat components", () => {
    const files = walk(join(SRC_ROOT, "features", "chat")).filter((file) =>
      file.endsWith(".tsx")
    );

    it("reaches for a token rather than a palette utility", () => {
      const findings: Finding[] = [];
      for (const file of files) {
        const source = stripTsComments(readFileSync(file, "utf8"));
        for (const literal of source.matchAll(STRING_LITERAL)) {
          const text = literal[1] ?? literal[2] ?? literal[3] ?? "";
          for (const match of text.matchAll(PALETTE_UTILITY)) {
            findings.push({
              file,
              line: lineOf(source, literal.index + (literal[0] ?? "").indexOf(match[0])),
              detail: `${match[0]} is a Tailwind palette utility — the themed equivalent (text-green, bg-amber-dim, …) is what repaints with the theme`,
            });
          }
        }
      }
      expect(findings, `Palette utilities in chat components:\n${report(findings)}`).toEqual([]);
    });

    it("keeps colour out of inline styles and SVG props", () => {
      const findings: Finding[] = [];
      for (const file of files) {
        const source = stripTsComments(readFileSync(file, "utf8"));
        for (const match of source.matchAll(RAW_COLOUR)) {
          findings.push({
            file,
            line: lineOf(source, match.index),
            detail: `${match[0]} is a literal — a component styles itself through its chat-* class and the token layer`,
          });
        }
      }
      expect(findings, `Raw colours in chat components:\n${report(findings)}`).toEqual([]);
    });
  });

  describe("the chat surface", () => {
    const path = join(SRC_ROOT, STRICT_SURFACE);
    const css = stripComments(readFileSync(path, "utf8"));
    const rel = relative(SRC_ROOT, path);

    it("takes every colour from a token", () => {
      const findings: Finding[] = [...css.matchAll(RAW_COLOUR)].map((match) => ({
        file: path,
        line: lineOf(css, match.index),
        detail: `${match[0]} is a literal — reach for the tiered token instead (--ds-*, --text-*, --green, --chat-*)`,
      }));
      expect(findings, `Raw colours in ${rel}:\n${report(findings)}`).toEqual([]);
    });

    it("never papers over a missing token with a fallback", () => {
      const findings: Finding[] = [];
      for (const match of css.matchAll(REFERENCE)) {
        if (!match[2]) continue;
        findings.push({
          file: path,
          line: lineOf(css, match.index),
          detail: `var(${match[1]}, …) carries a fallback; a token that resolves needs none, and one that does not should fail loudly`,
        });
      }
      expect(findings, `Token fallbacks in ${rel}:\n${report(findings)}`).toEqual([]);
    });

    it("sets every font-family, box-shadow and border-radius from a token", () => {
      const findings: Finding[] = [];
      for (const [property, pattern] of [
        ["font-family", /font-family\s*:\s*([^;}]+)/g],
        ["box-shadow", /box-shadow\s*:\s*([^;}]+)/g],
        ["border-radius", /border-radius\s*:\s*([^;}]+)/g],
      ] as const) {
        for (const match of css.matchAll(pattern)) {
          const value = (match[1] ?? "").trim();
          if (value.includes("var(--")) continue;
          if (property === "border-radius" && MICRO_RADIUS.test(value)) continue;
          findings.push({
            file: path,
            line: lineOf(css, match.index),
            detail: `${property}: ${value}`,
          });
        }
      }
      expect(findings, `Untokenised chrome in ${rel}:\n${report(findings)}`).toEqual([]);
    });
  });
});
