// ============================================================
// Formatter Service — Prettier-powered code formatting
// ============================================================
// Supports JS, TS, HTML, CSS, JSON, and Markdown.
// Uses Prettier loaded as an ESM module.
// ============================================================

import type { Language } from "@/types";
import * as prettier from "prettier/standalone";
import * as parserBabel from "prettier/plugins/babel";
import * as parserEstree from "prettier/plugins/estree";
import * as parserHtml from "prettier/plugins/html";
import * as parserTypeScript from "prettier/plugins/typescript";

/** Parser mapping for Prettier */
const PARSER_MAP: Record<string, { parser: string; plugins: any[] }> = {
  javascript: {
    parser: "babel",
    plugins: [parserBabel, parserEstree],
  },
  typescript: {
    parser: "typescript",
    plugins: [parserTypeScript, parserEstree],
  },
  html: {
    parser: "html",
    plugins: [parserHtml],
  },
  json: {
    parser: "json",
    plugins: [parserBabel, parserEstree],
  },
};

/**
 * Format code using Prettier.
 * Returns the formatted code string, or throws on failure.
 */
export async function formatCode(
  code: string,
  language: Language | string
): Promise<string> {
  const config = PARSER_MAP[language];

  if (!config) {
    // For unsupported languages (e.g. Python), return as-is
    throw new Error(`Formatting not supported for ${language}`);
  }

  const formatted = await prettier.format(code, {
    parser: config.parser,
    plugins: config.plugins,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    printWidth: 100,
    arrowParens: "always",
  });

  return formatted;
}

/**
 * Check if a language supports formatting.
 */
export function supportsFormatting(language: Language | string): boolean {
  return language in PARSER_MAP;
}
