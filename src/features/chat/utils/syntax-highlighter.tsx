// ============================================================
// Multi-Language Syntax Highlighter for AI Chat
// Clean, token-based tokenizer supporting major programming languages
// ============================================================

import React from "react";

// Language alias mapper
export function normalizeLanguage(lang?: string): string {
  if (!lang) return "text";
  const clean = lang.toLowerCase().trim();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    typescript: "typescript",
    js: "javascript",
    jsx: "javascript",
    javascript: "javascript",
    py: "python",
    python: "python",
    json: "json",
    html: "html",
    xml: "html",
    svg: "html",
    css: "css",
    scss: "css",
    sass: "css",
    less: "css",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown",
  };
  return map[clean] || clean;
}

// ── TypeScript / JavaScript Tokenizer ────────────────────────
const TS_REGEX =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:number|string|boolean|any|void|unknown|never|object|symbol|bigint|Array|Record|Promise|Map|Set|UUID|Date|RegExp|Function|Error|JSX)\b|\b[A-Z][a-zA-Z0-9_]*(?=\s*<|\s*\[\]|\s*;|\s*,|\s*=|\s*\)|\s*\{))|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|new|typeof|instanceof|async|await|yield|import|export|from|class|interface|type|extends|implements|enum|as|is)\b)|(\b(?:true|false|null|undefined|NaN|Infinity)\b)|(-?\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][\w$]*(?=\s*\())|(?<=\.)([a-zA-Z_$][\w$]*)|(\s+)|([^\s\w$]+|[a-zA-Z_$][\w$]*)/g;

// ── Python Tokenizer ────────────────────────────────────────
const PYTHON_REGEX =
  /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|lambda|yield|raise|pass|break|continue|global|nonlocal|async|await|assert|del|in|is|not|and|or)\b)|(\b(?:True|False|None|self|cls)\b)|(\b(?:int|float|str|bool|list|dict|set|tuple|bytes|bytearray|range|enumerate|zip|filter|map|sorted|len|open|print|isinstance|issubclass)\b)|(-?\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_]\w*(?=\s*\())|(\s+)|([^\s\w]+|[a-zA-Z_]\w*)/g;

// ── JSON Tokenizer ──────────────────────────────────────────
const JSON_REGEX =
  /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}\[\],])|(\s+)|([^"{}\[\],\s]+)/g;

// ── SQL Tokenizer ───────────────────────────────────────────
const SQL_REGEX =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|AS|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CREATE|TABLE|DROP|ALTER|INDEX|VIEW|TRIGGER|CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CASCADE|CONSTRAINT)\b)/gi;

// ── Bash / Shell Tokenizer ──────────────────────────────────
const BASH_REGEX =
  /(#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\$[a-zA-Z0-9_]+|\${[^}]+})|(\b(?:echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|curl|wget|npm|npx|pnpm|yarn|git|node|python|docker|sudo|export|source|exit|if|then|else|fi|for|do|done|while|case|esac)\b)|(--?[a-zA-Z0-9_-]+)|(\s+)|([^\s]+)/g;

// ── HTML / XML Tokenizer ────────────────────────────────────
const HTML_REGEX =
  /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z0-9:-]+)|(\s+([a-zA-Z0-9:-]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?)|(\/?>)|([^<]+)/g;

// ── CSS Tokenizer ───────────────────────────────────────────
const CSS_REGEX =
  /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([.#]?[a-zA-Z0-9_-]+(?=\s*\{))|([a-zA-Z0-9_-]+)(?=\s*:)|(-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms|deg|fr)?)|(\b(?:none|inherit|initial|auto|relative|absolute|fixed|sticky|flex|grid|block|inline|inline-block|transparent|currentColor)\b)|(\s+)|([^\s]+)/g;

export function renderHighlightedCode(code: string, language?: string): React.ReactNode[] {
  const normLang = normalizeLanguage(language);

  switch (normLang) {
    case "python":
      return highlightPython(code);
    case "json":
      return highlightJson(code);
    case "sql":
      return highlightSql(code);
    case "bash":
      return highlightBash(code);
    case "html":
      return highlightHtml(code);
    case "css":
      return highlightCss(code);
    case "typescript":
    case "javascript":
    default:
      return highlightTs(code);
  }
}

function highlightTs(code: string): React.ReactNode[] {
  TS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = TS_REGEX.exec(code)) !== null) {
    const text = match[0];
    const key = `ts-${idx++}`;

    if (match[1]) {
      nodes.push(<span key={key} className="token-comment">{text}</span>);
    } else if (match[2]) {
      nodes.push(<span key={key} className="token-str">{text}</span>);
    } else if (match[3]) {
      nodes.push(<span key={key} className="token-type">{text}</span>);
    } else if (match[4]) {
      nodes.push(<span key={key} className="token-keyword">{text}</span>);
    } else if (match[5]) {
      nodes.push(<span key={key} className="token-bool">{text}</span>);
    } else if (match[6]) {
      nodes.push(<span key={key} className="token-num">{text}</span>);
    } else if (match[7]) {
      nodes.push(<span key={key} className="token-fn">{text}</span>);
    } else if (match[8]) {
      nodes.push(<span key={key} className="token-prop">{text}</span>);
    } else if (match[9]) {
      nodes.push(text);
    } else {
      const isOp = /^[=><!+\-*/%&|^~?:]+$/.test(text);
      const isDel = /^[{}()[\];,.]+$/.test(text);
      if (isOp) {
        nodes.push(<span key={key} className="token-op">{text}</span>);
      } else if (isDel) {
        nodes.push(<span key={key} className="token-del">{text}</span>);
      } else {
        nodes.push(<span key={key} className="token-var">{text}</span>);
      }
    }
  }

  return nodes.length > 0 ? nodes : [code];
}

function highlightPython(code: string): React.ReactNode[] {
  PYTHON_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = PYTHON_REGEX.exec(code)) !== null) {
    const text = match[0];
    const key = `py-${idx++}`;

    if (match[1]) {
      nodes.push(<span key={key} className="token-comment">{text}</span>);
    } else if (match[2]) {
      nodes.push(<span key={key} className="token-str">{text}</span>);
    } else if (match[3]) {
      nodes.push(<span key={key} className="token-keyword">{text}</span>);
    } else if (match[4]) {
      nodes.push(<span key={key} className="token-bool">{text}</span>);
    } else if (match[5]) {
      nodes.push(<span key={key} className="token-type">{text}</span>);
    } else if (match[6]) {
      nodes.push(<span key={key} className="token-num">{text}</span>);
    } else if (match[7]) {
      nodes.push(<span key={key} className="token-fn">{text}</span>);
    } else if (match[8]) {
      nodes.push(text);
    } else {
      nodes.push(<span key={key} className="token-var">{text}</span>);
    }
  }

  return nodes.length > 0 ? nodes : [code];
}

function highlightJson(code: string): React.ReactNode[] {
  JSON_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = JSON_REGEX.exec(code)) !== null) {
    const key = `json-${idx++}`;

    if (match[1]) {
      if (match[2]) {
        nodes.push(<span key={key} className="token-prop">{match[1]}</span>);
        nodes.push(<span key={`col-${idx++}`} className="token-del">{match[2]}</span>);
      } else {
        nodes.push(<span key={key} className="token-str">{match[1]}</span>);
      }
    } else if (match[3]) {
      nodes.push(<span key={key} className="token-bool">{match[3]}</span>);
    } else if (match[4]) {
      nodes.push(<span key={key} className="token-num">{match[4]}</span>);
    } else if (match[5]) {
      nodes.push(<span key={key} className="token-del">{match[5]}</span>);
    } else if (match[6]) {
      nodes.push(match[6]);
    } else {
      nodes.push(match[0]);
    }
  }

  return nodes.length > 0 ? nodes : [code];
}

function highlightSql(code: string): React.ReactNode[] {
  SQL_REGEX.lastIndex = 0;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = SQL_REGEX.exec(code)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(code.slice(lastIndex, match.index));
    }
    const text = match[0];
    const key = `sql-${idx++}`;

    if (match[1]) {
      nodes.push(<span key={key} className="token-comment">{text}</span>);
    } else if (match[2]) {
      nodes.push(<span key={key} className="token-str">{text}</span>);
    } else if (match[3]) {
      nodes.push(<span key={key} className="token-keyword font-semibold">{text}</span>);
    }
    lastIndex = match.index + text.length;
  }

  if (lastIndex < code.length) {
    nodes.push(code.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [code];
}

function highlightBash(code: string): React.ReactNode[] {
  BASH_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = BASH_REGEX.exec(code)) !== null) {
    const text = match[0];
    const key = `sh-${idx++}`;

    if (match[1]) {
      nodes.push(<span key={key} className="token-comment">{text}</span>);
    } else if (match[2]) {
      nodes.push(<span key={key} className="token-str">{text}</span>);
    } else if (match[3]) {
      nodes.push(<span key={key} className="token-var text-amber-400 font-mono">{text}</span>);
    } else if (match[4]) {
      nodes.push(<span key={key} className="token-keyword font-semibold">{text}</span>);
    } else if (match[5]) {
      nodes.push(<span key={key} className="token-prop text-cyan-400">{text}</span>);
    } else if (match[6]) {
      nodes.push(text);
    } else {
      nodes.push(text);
    }
  }

  return nodes.length > 0 ? nodes : [code];
}

function highlightHtml(code: string): React.ReactNode[] {
  HTML_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = HTML_REGEX.exec(code)) !== null) {
    const key = `html-${idx++}`;

    if (match[1]) {
      // Comment
      nodes.push(<span key={key} className="token-comment">{match[1]}</span>);
    } else if (match[2] && match[3]) {
      // Tag opening or closing
      nodes.push(<span key={`tag-b-${key}`} className="token-del">{match[2]}</span>);
      nodes.push(<span key={`tag-n-${key}`} className="token-keyword font-semibold">{match[3]}</span>);
    } else if (match[4]) {
      // Attribute and value
      if (match[5]) {
        nodes.push(<span key={`attr-${key}`} className="token-prop">{` ${match[5]}`}</span>);
      }
      if (match[6]) {
        nodes.push(<span key={`eq-${key}`} className="token-del">=</span>);
        nodes.push(<span key={`val-${key}`} className="token-str">{match[6]}</span>);
      }
    } else if (match[7]) {
      // Tag close >
      nodes.push(<span key={`tag-c-${key}`} className="token-del">{match[7]}</span>);
    } else if (match[8]) {
      nodes.push(match[8]);
    } else {
      nodes.push(match[0]);
    }
  }

  return nodes.length > 0 ? nodes : [code];
}

function highlightCss(code: string): React.ReactNode[] {
  CSS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = CSS_REGEX.exec(code)) !== null) {
    const text = match[0];
    const key = `css-${idx++}`;

    if (match[1]) {
      nodes.push(<span key={key} className="token-comment">{text}</span>);
    } else if (match[2]) {
      nodes.push(<span key={key} className="token-str">{text}</span>);
    } else if (match[3]) {
      nodes.push(<span key={key} className="token-keyword font-semibold">{text}</span>);
    } else if (match[4]) {
      nodes.push(<span key={key} className="token-prop">{text}</span>);
    } else if (match[5]) {
      nodes.push(<span key={key} className="token-num">{text}</span>);
    } else if (match[6]) {
      nodes.push(<span key={key} className="token-type">{text}</span>);
    } else if (match[7]) {
      nodes.push(text);
    } else {
      nodes.push(text);
    }
  }

  return nodes.length > 0 ? nodes : [code];
}
