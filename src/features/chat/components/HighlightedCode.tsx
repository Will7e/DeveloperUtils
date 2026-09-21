// ============================================================
// Highlighted Code — Renders a Token Stream as Colored Spans
// ============================================================
// Component half of features/chat/highlight.ts (tokenization lives
// there; this file exists so the component is the only React export
// in its module, keeping Fast Refresh effective).

import React from "react";
import type { Token } from "../highlight";

const TOKEN_CLASS: Record<Token["kind"], string> = {
  comment: "token-comment",
  string: "token-str",
  type: "token-type",
  keyword: "token-keyword",
  bool: "token-bool",
  number: "token-num",
  fn: "token-fn",
  prop: "token-prop",
  operator: "token-op",
  delimiter: "token-del",
  word: "token-var",
  text: "",
};

export const HighlightedCodeSpan = React.memo(function HighlightedCodeSpan({
  tokens,
}: {
  tokens: Token[];
}) {
  const nodes: React.ReactNode[] = [];
  let idx = 0;
  for (const token of tokens) {
    if (TOKEN_CLASS[token.kind] === "") {
      nodes.push(token.text);
    } else {
      nodes.push(
        <span key={idx++} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      );
    }
  }
  return <>{nodes}</>;
});
