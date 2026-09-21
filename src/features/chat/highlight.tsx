// ============================================================
// Highlighter — Token Colors for Chat Code Blocks
// ============================================================
// Reuses the dashboard tokenizer style (`token-*` classes from
// styles/dashboard.css, matched to the InTab Monaco themes).
// Handles language auto-detection for bare ``` fences so pasted
// JSON or shell snippets still get colored. Pure regex — no
// dependencies. Plain text for unknown languages is always a
// safe fallback (just uncolored).
//
// The React renderer for the token stream lives in
// components/HighlightedCode.tsx (keeps this file component-free
// so Fast Refresh stays effective).
// ============================================================

export type TokenKind =
  | "comment"
  | "string"
  | "type"
  | "keyword"
  | "bool"
  | "number"
  | "fn"
  | "prop"
  | "operator"
  | "delimiter"
  | "word"
  | "text";

/** Single classification per token — the classifier maps kinds to
 *  `token-*` classes in one place, so regex capture indexes can
 *  never drift out of sync with rendering. */
export interface Token {
  kind: TokenKind;
  text: string;
}

export interface HighlightedCode {
  /** Canonical display language for the code bar chip */
  language: string;
  /** Empty when the language is unsupported — render code verbatim */
  tokens: Token[];
}

/** Lowercase aliases → canonical display name */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  node: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON",
};

/** Map a fence tag to a canonical language, or null when unsupported */
function canonicalLanguage(fence?: string): string | null {
  if (!fence) return null;
  return LANGUAGE_ALIASES[fence.toLowerCase().trim()] ?? null;
}

/**
 * Guess the language of an untagged code block. Conservative: only
 * returns a language when the evidence is strong, otherwise the
 * block renders as plain (safe) text.
 */
function detectLanguage(code: string): string | null {
  const trimmed = code.trimStart();

  // JSON: object/array start that actually parses
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "JSON";
    } catch {
      /* not JSON after all */
    }
  }

  // Shell: first line is a shebang or a common command prefix
  const firstLine = trimmed.split("\n", 1)[0]?.trim() ?? "";
  if (/^#!\s*\/.*(ba)?sh\b/.test(firstLine)) return "Shell";
  if (/^(\$\s|npm (run|install|i)\b|yarn\b|pnpm\b|git (add|commit|push|pull|status|checkout)\b)/.test(firstLine)) {
    return "Shell";
  }

  return null;
}

// ── TS / JavaScript ─────────────────────────────────────────
// Alternatives in priority order. Capture-free (lookarounds only)
// so a token kind is derived from which alternative matched, never
// from a capture index that can silently shift.

const TS_ALTERNATIVES: Array<[RegExp, TokenKind]> = [
  [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, "comment"],
  [/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y, "string"],
  [/\b(?:number|string|boolean|any|void|unknown|never|object|symbol|bigint|Array|Record|Promise|Map|Set|Date|RegExp|Function|Error)\b/y, "type"],
  [/\b[A-Z][a-zA-Z0-9_]*\b/y, "type"],
  [
    /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|new|typeof|instanceof|async|await|yield|import|export|from|class|interface|type|extends|implements|in|of)\b/y,
    "keyword",
  ],
  [/\b(?:true|false|null|undefined|NaN|Infinity)\b/y, "bool"],
  [/-?\b\d+(?:\.\d+)?\b/y, "number"],
  [/\b[a-zA-Z_$][\w$]*(?=\s*\()/y, "fn"],
  [/(?<=\.)[a-zA-Z_$][\w$]*(?!\s*\()/y, "prop"],
  [/\s+/y, "text"],
];

function tokenizeTs(code: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  outer: while (pos < code.length) {
    for (const [regex, kind] of TS_ALTERNATIVES) {
      regex.lastIndex = pos;
      const m = regex.exec(code);
      if (m && m.index === pos && m[0].length > 0) {
        tokens.push({ kind, text: m[0] });
        pos += m[0].length;
        continue outer;
      }
    }

    // Fallback: single char via the tail alternative semantics
    const ch = code[pos]!;
    const isOp = /[=><!+\-*/%&|^~?:]/.test(ch);
    const isDel = /[{}()[\];,.]/.test(ch);
    if (isOp || isDel) {
      tokens.push({ kind: isOp ? "operator" : "delimiter", text: ch });
      pos += 1;
      continue;
    }

    // Identifier / word: consume greedily so words stay whole
    const rest = code.slice(pos);
    const word = rest.match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      tokens.push({ kind: "word", text: word[0] });
      pos += word[0].length;
    } else {
      tokens.push({ kind: "word", text: ch });
      pos += 1;
    }
  }

  return tokens;
}

// ── JSON ────────────────────────────────────────────────────
// Property keys are detected structurally: a string token whose
// next non-text token is ":" is a key.

const JSON_STRING_REGEX = /"(?:\\.|[^"\\])*"/y;
const JSON_KEYWORD_REGEX = /\b(?:true|false|null)\b/y;
const JSON_NUMBER_REGEX = /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y;

function tokenizeJson(code: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  const pushText = (text: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === "text") last.text += text;
    else tokens.push({ kind: "text", text });
  };

  while (pos < code.length) {
    const ch = code[pos]!;

    if (/\s/.test(ch)) {
      pushText(ch);
      pos += 1;
      continue;
    }

    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "," || ch === ":") {
      tokens.push({ kind: "delimiter", text: ch });
      pos += 1;
      continue;
    }

    if (ch === '"') {
      JSON_STRING_REGEX.lastIndex = pos;
      const m = JSON_STRING_REGEX.exec(code);
      if (m && m.index === pos) {
        // Look ahead: is the next non-whitespace char a colon?
        let k = pos + m[0].length;
        while (k < code.length && /\s/.test(code[k]!)) k++;
        const isKey = code[k] === ":";
        tokens.push({ kind: isKey ? "prop" : "string", text: m[0] });
        pos += m[0].length;
        continue;
      }
    }

    JSON_KEYWORD_REGEX.lastIndex = pos;
    const kw = JSON_KEYWORD_REGEX.exec(code);
    if (kw && kw.index === pos && kw[0].length > 0) {
      tokens.push({ kind: "bool", text: kw[0] });
      pos += kw[0].length;
      continue;
    }

    JSON_NUMBER_REGEX.lastIndex = pos;
    const num = JSON_NUMBER_REGEX.exec(code);
    if (num && num.index === pos && num[0].length > 0) {
      tokens.push({ kind: "number", text: num[0] });
      pos += num[0].length;
      continue;
    }

    // Unknown char — pass through as text (safe fallback)
    pushText(ch);
    pos += 1;
  }

  return tokens;
}

// ── Shell ───────────────────────────────────────────────────

const SHELL_COMMENT_REGEX = /#[^\n]*/y;
const SHELL_STRING_REGEX = /"[^"\n]*"|'[^'\n]*'/y;

function tokenizeShell(code: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < code.length) {
    const ch = code[pos]!;

    if (/\s/.test(ch)) {
      const last = tokens[tokens.length - 1];
      if (last && last.kind === "text") last.text += ch;
      else tokens.push({ kind: "text", text: ch });
      pos += 1;
      continue;
    }

    SHELL_COMMENT_REGEX.lastIndex = pos;
    const comment = SHELL_COMMENT_REGEX.exec(code);
    if (comment && comment.index === pos && comment[0].length > 0) {
      tokens.push({ kind: "comment", text: comment[0] });
      pos += comment[0].length;
      continue;
    }

    SHELL_STRING_REGEX.lastIndex = pos;
    const str = SHELL_STRING_REGEX.exec(code);
    if (str && str.index === pos && str[0].length > 0) {
      tokens.push({ kind: "string", text: str[0] });
      pos += str[0].length;
      continue;
    }

    // Word (command or argument)
    const word = code.slice(pos).match(/^[^\s#"']+/);
    if (word) {
      tokens.push({ kind: "word", text: word[0] });
      pos += word[0].length;
      continue;
    }

    tokens.push({ kind: "word", text: ch });
    pos += 1;
  }

  return tokens;
}

// ── Dispatch ────────────────────────────────────────────────

/**
 * Highlights a code block for chat display. Returns an empty token
 * list for unsupported languages — callers render the code verbatim
 * (always correct, just uncolored).
 */
export function highlightCode(code: string, fenceLanguage?: string): HighlightedCode {
  let language = canonicalLanguage(fenceLanguage);
  if (!language && !fenceLanguage) {
    language = detectLanguage(code);
  }

  if (language === "JSON") return { language, tokens: tokenizeJson(code) };
  if (language === "Shell") return { language, tokens: tokenizeShell(code) };
  if (language === "JavaScript" || language === "TypeScript") {
    return { language, tokens: tokenizeTs(code) };
  }

  return { language: language ?? fenceLanguage ?? "", tokens: [] };
}
