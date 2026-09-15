// ============================================================
// Auto-Formatting Engine for Diff Checker
// Supports JSON (with auto-repair), XML, HTML, CSS, JavaScript,
// TypeScript, YAML, Markdown, SQL, and Monaco fallbacks.
// ============================================================

import * as prettier from "prettier/standalone";
import * as parserBabel from "prettier/plugins/babel";
import * as parserEstree from "prettier/plugins/estree";
import * as parserHtml from "prettier/plugins/html";
import * as parserPostcss from "prettier/plugins/postcss";
import * as parserTypeScript from "prettier/plugins/typescript";
import * as parserYaml from "prettier/plugins/yaml";
import * as parserMarkdown from "prettier/plugins/markdown";

import { formatJsonRobust } from "@/features/formatters/jsonUtils";
import { formatXml } from "@/features/formatters/xmlUtils";

export interface FormatResult {
  success: boolean;
  formatted: string;
  error?: string;
}

/**
 * Lightweight, robust SQL formatter for query beautification.
 */
export function formatSql(sql: string): string {
  if (!sql.trim()) return sql;

  const majorKeywords = [
    "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY",
    "LIMIT", "OFFSET", "UNION ALL", "UNION", "INSERT INTO", "VALUES",
    "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE",
    "DROP TABLE", "TRUNCATE TABLE", "LEFT JOIN", "RIGHT JOIN",
    "INNER JOIN", "FULL JOIN", "CROSS JOIN", "JOIN"
  ];

  const minorKeywords = [
    "AND", "OR", "ON", "AS", "IN", "NOT IN", "IS NULL", "IS NOT NULL",
    "BETWEEN", "LIKE", "CASE", "WHEN", "THEN", "ELSE", "END",
    "ASC", "DESC", "DISTINCT", "EXISTS", "COUNT", "SUM", "AVG", "MIN", "MAX"
  ];

  // Tokenize while preserving string literals
  const tokens: string[] = [];
  let current = "";
  let inString: false | "'" | '"' = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (inString) {
      current += char;
      if (char === inString && sql[i - 1] !== "\\") {
        inString = false;
        tokens.push(current);
        current = "";
      }
    } else if (char === "'" || char === '"') {
      if (current.trim()) tokens.push(current.trim());
      current = char;
      inString = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else if (char === "," || char === ";" || char === "(" || char === ")") {
      if (current) {
        tokens.push(current);
        current = "";
      }
      tokens.push(char);
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);

  // Build formatted output
  let result = "";
  let indent = 0;
  const pad = () => "  ".repeat(Math.max(0, indent));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const upper = token.toUpperCase();

    // Check for two-word major keywords like "GROUP BY"
    const nextToken = tokens[i + 1]?.toUpperCase();
    const twoWord = nextToken ? `${upper} ${nextToken}` : "";

    if (majorKeywords.includes(twoWord)) {
      i++; // skip nextToken
      indent = Math.max(0, indent - 1);
      result += (result ? "\n" : "") + pad() + twoWord;
      indent++;
      result += "\n" + pad();
      continue;
    }

    if (majorKeywords.includes(upper)) {
      indent = Math.max(0, indent - 1);
      result += (result ? "\n" : "") + pad() + upper;
      indent++;
      result += "\n" + pad();
      continue;
    }

    if (upper === "AND" || upper === "OR") {
      result += "\n" + pad() + upper + " ";
      continue;
    }

    if (minorKeywords.includes(upper)) {
      result += upper + " ";
      continue;
    }

    if (token === ",") {
      result = result.trimEnd() + ",\n" + pad();
      continue;
    }

    if (token === "(") {
      indent++;
      result += "(\n" + pad();
      continue;
    }

    if (token === ")") {
      indent = Math.max(0, indent - 1);
      result = result.trimEnd() + "\n" + pad() + ")";
      continue;
    }

    if (token === ";") {
      result = result.trimEnd() + ";\n";
      continue;
    }

    result += token + " ";
  }

  return result.trim();
}

/**
 * Format content for a given language.
 */
export async function formatContent(
  content: string,
  language: string
): Promise<FormatResult> {
  const trimmed = content.trim();
  if (!trimmed) {
    return { success: true, formatted: content };
  }

  const lang = (language || "plaintext").toLowerCase();

  try {
    // 1. JSON formatting (with auto-repair for trailing commas, comments, single quotes)
    if (lang === "json") {
      try {
        const formatted = formatJsonRobust(trimmed, { tabSize: 2, sortKeys: false });
        return { success: true, formatted };
      } catch {
        const parsed = JSON.parse(trimmed);
        return { success: true, formatted: JSON.stringify(parsed, null, 2) };
      }
    }

    // 2. XML / SVG / XHTML formatting
    if (lang === "xml") {
      const formatted = formatXml(trimmed, "  ");
      return { success: true, formatted };
    }

    // 3. SQL formatting
    if (lang === "sql") {
      const formatted = formatSql(trimmed);
      return { success: true, formatted };
    }

    // 4. HTML formatting
    if (lang === "html") {
      const formatted = await prettier.format(trimmed, {
        parser: "html",
        plugins: [parserHtml],
        tabWidth: 2,
        printWidth: 100,
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 5. CSS / SCSS formatting
    if (lang === "css") {
      const formatted = await prettier.format(trimmed, {
        parser: "css",
        plugins: [parserPostcss],
        tabWidth: 2,
        printWidth: 100,
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 6. JavaScript / JSX formatting
    if (lang === "javascript") {
      const formatted = await prettier.format(trimmed, {
        parser: "babel",
        plugins: [parserBabel, parserEstree],
        semi: true,
        singleQuote: false,
        tabWidth: 2,
        printWidth: 100,
        arrowParens: "always",
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 7. TypeScript / TSX formatting
    if (lang === "typescript") {
      const formatted = await prettier.format(trimmed, {
        parser: "typescript",
        plugins: [parserTypeScript, parserEstree],
        semi: true,
        singleQuote: false,
        tabWidth: 2,
        printWidth: 100,
        arrowParens: "always",
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 8. YAML formatting
    if (lang === "yaml") {
      const formatted = await prettier.format(trimmed, {
        parser: "yaml",
        plugins: [parserYaml],
        tabWidth: 2,
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 9. Markdown formatting
    if (lang === "markdown") {
      const formatted = await prettier.format(trimmed, {
        parser: "markdown",
        plugins: [parserMarkdown],
        proseWrap: "preserve",
      });
      return { success: true, formatted: formatted.trim() };
    }

    // Unsupported language: return as-is
    return { success: false, formatted: content, error: `No formatter available for ${language}` };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, formatted: content, error: errorMsg };
  }
}

/**
 * Check if a language has a dedicated formatter.
 */
export function isFormatSupported(language: string): boolean {
  const supported = ["json", "xml", "javascript", "typescript", "html", "css", "yaml", "markdown", "sql"];
  return supported.includes((language || "").toLowerCase());
}

/**
 * Format both Original and Modified sides.
 */
export async function formatBothSides(
  original: string,
  modified: string,
  language: string
): Promise<{ original: string; modified: string; changed: boolean; errors: string[] }> {
  const errors: string[] = [];
  let nextOrig = original;
  let nextMod = modified;
  let changed = false;

  if (original.trim()) {
    const resOrig = await formatContent(original, language);
    if (resOrig.success && resOrig.formatted !== original) {
      nextOrig = resOrig.formatted;
      changed = true;
    } else if (resOrig.error) {
      errors.push(`Original: ${resOrig.error}`);
    }
  }

  if (modified.trim()) {
    const resMod = await formatContent(modified, language);
    if (resMod.success && resMod.formatted !== modified) {
      nextMod = resMod.formatted;
      changed = true;
    } else if (resMod.error) {
      errors.push(`Modified: ${resMod.error}`);
    }
  }

  return { original: nextOrig, modified: nextMod, changed, errors };
}
