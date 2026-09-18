import React from "react";

/**
 * Strips TypeScript types and annotations so native browser V8 Function() can evaluate code.
 */
export function stripTsTypes(code: string): string {
  const TYPE_NAMES =
    "(?:number|string|boolean|any|void|unknown|never|object|symbol|bigint|UUID|Date|RegExp|Error)";
  const typeRegex = new RegExp(
    ":\\s*(?:" + TYPE_NAMES + "\\[\\]|Array<[^>]+>|" + TYPE_NAMES + ")",
    "g"
  );

  return code
    .replace(/\b(?:interface|type)\s+[A-Za-z0-9_]+[\s\S]*?(?:;|\})/g, "")
    .replace(/\s+as\s+[A-Za-z0-9_<>\[\]]+/g, "")
    .replace(typeRegex, "");
}

/**
 * Tokenizer regex for TypeScript / JavaScript in live previews.
 * Group 1: Comments
 * Group 2: Strings
 * Group 3: Data Types (primitives, built-ins, and PascalCase types)
 * Group 4: Keywords
 * Group 5: Booleans & Null
 * Group 6: Numbers
 * Group 7: Function invocations / definitions
 * Group 8: Property / method access
 * Group 9: Whitespace
 * Group 10: Delimiters / operators / variables
 */
const TS_TOKEN_REGEX =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:number|string|boolean|any|void|unknown|never|object|symbol|bigint|Array|Record|Promise|Map|Set|UUID|Date|RegExp|Function|Error|GlideRecord|RESTMessageV2|GlideDateTime|XMLDocument2)\b|\b[A-Z][a-zA-Z0-9_]*(?=\s*<|\s*\[\]|\s*;|\s*,|\s*=|\s*\)|\s*\{))|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|new|typeof|instanceof|async|await|yield|import|export|from|class|interface|type|extends|implements)\b)|(\b(?:true|false|null|undefined|NaN|Infinity)\b)|(-?\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][\w$]*(?=\s*\())|(?<=\.)([a-zA-Z_$][\w$]*)|(\s+)|([^\s\w$]+|[a-zA-Z_$][\w$]*)/g;

export function renderHighlightedTs(code: string): React.ReactNode[] {
  TS_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = TS_TOKEN_REGEX.exec(code)) !== null) {
    const text = match[0];
    const key = `ts-${idx++}`;

    if (match[1]) {
      // Comment
      nodes.push(
        <span key={key} className="token-comment">
          {text}
        </span>
      );
    } else if (match[2]) {
      // String
      nodes.push(
        <span key={key} className="token-str">
          {text}
        </span>
      );
    } else if (match[3]) {
      // Data Type (number, string, boolean, any, UUID, etc.)
      nodes.push(
        <span key={key} className="token-type">
          {text}
        </span>
      );
    } else if (match[4]) {
      // Keyword
      nodes.push(
        <span key={key} className="token-keyword">
          {text}
        </span>
      );
    } else if (match[5]) {
      // Boolean / Null
      nodes.push(
        <span key={key} className="token-bool">
          {text}
        </span>
      );
    } else if (match[6]) {
      // Number
      nodes.push(
        <span key={key} className="token-num">
          {text}
        </span>
      );
    } else if (match[7]) {
      // Function call
      nodes.push(
        <span key={key} className="token-fn">
          {text}
        </span>
      );
    } else if (match[8]) {
      // Property / Method
      nodes.push(
        <span key={key} className="token-prop">
          {text}
        </span>
      );
    } else if (match[9]) {
      // Whitespace (preserve exact indentation and line breaks)
      nodes.push(text);
    } else {
      // Delimiters & operators
      const isOp = /^[=><!+\-*/%&|^~?:]+$/.test(text);
      const isDel = /^[{}()[\];,.]+$/.test(text);
      if (isOp) {
        nodes.push(
          <span key={key} className="token-op">
            {text}
          </span>
        );
      } else if (isDel) {
        nodes.push(
          <span key={key} className="token-del">
            {text}
          </span>
        );
      } else {
        nodes.push(
          <span key={key} className="token-var">
            {text}
          </span>
        );
      }
    }
  }

  return nodes;
}

/**
 * Tokenizer regex for JSON in live previews.
 */
const JSON_TOKEN_REGEX =
  /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([{}\[\],])|(\s+)|([^"{}\[\],\s]+)/g;

export function renderHighlightedJson(json: string): React.ReactNode[] {
  JSON_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  const nodes: React.ReactNode[] = [];
  let idx = 0;

  while ((match = JSON_TOKEN_REGEX.exec(json)) !== null) {
    const key = `json-${idx++}`;

    if (match[1]) {
      if (match[2]) {
        // Property key
        nodes.push(
          <span key={key} className="token-prop">
            {match[1]}
          </span>
        );
        nodes.push(
          <span key={`col-${idx++}`} className="token-del">
            {match[2]}
          </span>
        );
      } else {
        // String value
        nodes.push(
          <span key={key} className="token-str">
            {match[1]}
          </span>
        );
      }
    } else if (match[3]) {
      // Boolean / Null
      nodes.push(
        <span key={key} className="token-bool">
          {match[3]}
        </span>
      );
    } else if (match[4]) {
      // Number
      nodes.push(
        <span key={key} className="token-num">
          {match[4]}
        </span>
      );
    } else if (match[5]) {
      // Delimiter
      nodes.push(
        <span key={key} className="token-del">
          {match[5]}
        </span>
      );
    } else if (match[6]) {
      // Whitespace
      nodes.push(match[6]);
    } else {
      nodes.push(match[0]);
    }
  }

  return nodes;
}
