// ============================================================
// Formatter Service — Universal Prettier & Robust Code Formatter
// Supports JS, TS, HTML, CSS, JSON (with auto-repair), XML,
// SQL, YAML, Markdown, and Monaco fallbacks.
// ============================================================

import type { Language } from "@/types";
// Prettier is ~1.5MB minified — the single biggest dependency in the
// app. It's only needed when the user actually formats code, so every
// module (including its plugins) is loaded on demand via dynamic
// import. This keeps the main bundle lean for first paint.
type PrettierModule = typeof import("prettier/standalone");

let prettierPromise: Promise<PrettierModule> | null = null;
async function loadPrettier(): Promise<PrettierModule> {
  if (!prettierPromise) {
    prettierPromise = import("prettier/standalone");
  }
  return prettierPromise;
}

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

  let result = "";
  let indent = 0;
  const pad = () => "  ".repeat(Math.max(0, indent));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const upper = token.toUpperCase();
    const nextToken = tokens[i + 1]?.toUpperCase();
    const twoWord = nextToken ? `${upper} ${nextToken}` : "";

    if (majorKeywords.includes(twoWord)) {
      i++;
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

/** Supported languages for universal formatting */
const SUPPORTED_LANGUAGES = new Set([
  "json",
  "xml",
  "javascript",
  "js",
  "typescript",
  "ts",
  "html",
  "css",
  "scss",
  "less",
  "yaml",
  "yml",
  "markdown",
  "md",
  "sql",
]);

/**
 * Check if a language has formatting support.
 */
export function supportsFormatting(language: Language | string): boolean {
  if (!language) return false;
  return SUPPORTED_LANGUAGES.has(language.toLowerCase());
}

export function isFormatSupported(language: string): boolean {
  return supportsFormatting(language);
}

/**
 * Format arbitrary code string for a given language.
 * Returns { success, formatted, error }.
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
    // 1. JSON formatting (with robust auto-repair)
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
      const [prettier, parserHtml, parserPostcss, parserBabel, parserEstree, parserTypeScript] = await Promise.all([
        loadPrettier(),
        import("prettier/plugins/html"),
        import("prettier/plugins/postcss"),
        import("prettier/plugins/babel"),
        import("prettier/plugins/estree"),
        import("prettier/plugins/typescript"),
      ]);
      const formatted = await prettier.format(trimmed, {
        parser: "html",
        plugins: [parserHtml, parserPostcss, parserBabel, parserEstree, parserTypeScript],
        tabWidth: 2,
        printWidth: 100,
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 5. CSS / SCSS formatting
    if (lang === "css" || lang === "scss" || lang === "less") {
      const [prettier, parserPostcss] = await Promise.all([
        loadPrettier(),
        import("prettier/plugins/postcss"),
      ]);
      const formatted = await prettier.format(trimmed, {
        parser: "css",
        plugins: [parserPostcss],
        tabWidth: 2,
        printWidth: 100,
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 6. JavaScript / JSX formatting
    if (lang === "javascript" || lang === "js") {
      const [prettier, parserBabel, parserEstree] = await Promise.all([
        loadPrettier(),
        import("prettier/plugins/babel"),
        import("prettier/plugins/estree"),
      ]);
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
    if (lang === "typescript" || lang === "ts") {
      const [prettier, parserTypeScript, parserEstree] = await Promise.all([
        loadPrettier(),
        import("prettier/plugins/typescript"),
        import("prettier/plugins/estree"),
      ]);
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
    if (lang === "yaml" || lang === "yml") {
      const [prettier, parserYaml] = await Promise.all([
        loadPrettier(),
        import("prettier/plugins/yaml"),
      ]);
      const formatted = await prettier.format(trimmed, {
        parser: "yaml",
        plugins: [parserYaml],
        tabWidth: 2,
      });
      return { success: true, formatted: formatted.trim() };
    }

    // 9. Markdown formatting
    if (lang === "markdown" || lang === "md") {
      const [prettier, parserMarkdown] = await Promise.all([
        loadPrettier(),
        import("prettier/plugins/markdown"),
      ]);
      const formatted = await prettier.format(trimmed, {
        parser: "markdown",
        plugins: [parserMarkdown],
        proseWrap: "preserve",
      });
      return { success: true, formatted: formatted.trim() };
    }

    return { success: false, formatted: content, error: `No formatter available for ${language}` };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, formatted: content, error: errorMsg };
  }
}

/**
 * Format code using Prettier / robust parser.
 * Returns the formatted code string, or throws on failure.
 */
export async function formatCode(
  code: string,
  language: Language | string
): Promise<string> {
  const res = await formatContent(code, language);
  if (!res.success && res.error) {
    throw new Error(res.error);
  }
  return res.formatted;
}
