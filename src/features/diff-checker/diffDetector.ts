// ============================================================
// Smart Language Detector for Diff Checker
// Analyzes both Original and Modified inputs jointly with
// syntactic validation, structural heuristics, and confidence scoring.
// ============================================================

import { parseJsonRobust } from "@/features/formatters/jsonUtils";

export interface DetectionResult {
  language: string;
  label: string;
  confidence: number; // 0 to 100
  reason?: string;
}

export interface DiffLanguageInfo {
  id: string;
  label: string;
  extensions: string[];
  category: "data" | "markup" | "style" | "script" | "system" | "document";
}

export const DIFF_LANGUAGES: DiffLanguageInfo[] = [
  { id: "plaintext", label: "Plain Text", extensions: [".txt", ".log"], category: "document" },
  { id: "json", label: "JSON", extensions: [".json"], category: "data" },
  { id: "xml", label: "XML", extensions: [".xml", ".svg", ".plist"], category: "markup" },
  { id: "html", label: "HTML", extensions: [".html", ".htm"], category: "markup" },
  { id: "css", label: "CSS", extensions: [".css", ".scss", ".less"], category: "style" },
  { id: "javascript", label: "JavaScript", extensions: [".js", ".jsx", ".mjs"], category: "script" },
  { id: "typescript", label: "TypeScript", extensions: [".ts", ".tsx", ".d.ts"], category: "script" },
  { id: "sql", label: "SQL", extensions: [".sql"], category: "data" },
  { id: "yaml", label: "YAML", extensions: [".yaml", ".yml"], category: "data" },
  { id: "markdown", label: "Markdown", extensions: [".md", ".markdown"], category: "document" },
  { id: "python", label: "Python", extensions: [".py"], category: "script" },
  { id: "shell", label: "Shell / Bash", extensions: [".sh", ".bash", ".zsh"], category: "system" },
  { id: "go", label: "Go", extensions: [".go"], category: "system" },
  { id: "rust", label: "Rust", extensions: [".rs"], category: "system" },
  { id: "java", label: "Java", extensions: [".java"], category: "system" },
  { id: "csharp", label: "C#", extensions: [".cs"], category: "system" },
  { id: "php", label: "PHP", extensions: [".php"], category: "script" },
  { id: "ruby", label: "Ruby", extensions: [".rb"], category: "script" },
  { id: "swift", label: "Swift", extensions: [".swift"], category: "system" },
  { id: "kotlin", label: "Kotlin", extensions: [".kt", ".kts"], category: "system" },
];

export function getLanguageInfo(id: string): DiffLanguageInfo {
  return DIFF_LANGUAGES.find((l) => l.id === id) || DIFF_LANGUAGES[0]!;
}

interface LanguageRule {
  lang: string;
  weight: number;
  pattern: RegExp;
}

const HEURISTIC_RULES: LanguageRule[] = [
  // XML
  { lang: "xml", weight: 35, pattern: /<\?xml\b/i },
  { lang: "xml", weight: 25, pattern: /xmlns(:[a-zA-Z0-9_-]+)?=["'][^"']+["']/i },
  { lang: "xml", weight: 20, pattern: /<!\[CDATA\[[\s\S]*?\]\]>/ },
  { lang: "xml", weight: 15, pattern: /<[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z][a-zA-Z0-9_-]*[\s>]/ },
  { lang: "xml", weight: 12, pattern: /<[a-zA-Z][a-zA-Z0-9_-]*(\s+[a-zA-Z_:][\w:.-]*=(["']).*?\2)*\s*\/>/ },

  // HTML
  { lang: "html", weight: 40, pattern: /<!DOCTYPE\s+html/i },
  { lang: "html", weight: 25, pattern: /<(html|head|body|div|span|p|a|ul|ol|li|table|thead|tbody|tr|td|th|form|input|button|textarea|select|option|header|footer|nav|section|article|aside|main|script|style|link|meta)\b/i },
  { lang: "html", weight: 15, pattern: /<\/(html|body|div|span|p|a|table|form|ul|ol|section|header|footer)>/i },

  // CSS
  { lang: "css", weight: 25, pattern: /@media\s+[^{]+{/ },
  { lang: "css", weight: 25, pattern: /@keyframes\s+[\w-]+\s*{/ },
  { lang: "css", weight: 20, pattern: /@import\s+["'][^"']+["']/ },
  { lang: "css", weight: 20, pattern: /(--[\w-]+)\s*:\s*[^;]+;/ },
  { lang: "css", weight: 15, pattern: /[.#:][\w-]+\s*\{[^}]*}/ },
  { lang: "css", weight: 12, pattern: /\b(display|flex|grid|margin|padding|background|color|font-size|border-radius|box-shadow|overflow|z-index)\s*:\s*[^;]+;/ },

  // SQL
  { lang: "sql", weight: 35, pattern: /\bSELECT\s+.+\s+FROM\b/i },
  { lang: "sql", weight: 35, pattern: /\bINSERT\s+INTO\s+\w+/i },
  { lang: "sql", weight: 35, pattern: /\bUPDATE\s+\w+\s+SET\b/i },
  { lang: "sql", weight: 35, pattern: /\bDELETE\s+FROM\s+\w+/i },
  { lang: "sql", weight: 30, pattern: /\bCREATE\s+TABLE\s+\w+/i },
  { lang: "sql", weight: 25, pattern: /\bALTER\s+TABLE\s+\w+/i },
  { lang: "sql", weight: 20, pattern: /\bWHERE\s+[\w.]+\s*(=|!=|<>|<|>|IN|LIKE|IS NULL|BETWEEN)\b/i },
  { lang: "sql", weight: 20, pattern: /\b(INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN\s+\w+\s+ON\b/i },
  { lang: "sql", weight: 15, pattern: /\bGROUP\s+BY\s+[\w.,\s]+/i },
  { lang: "sql", weight: 15, pattern: /\bORDER\s+BY\s+[\w.,\s]+(ASC|DESC)?\b/i },

  // TypeScript (differentiated from JavaScript)
  { lang: "typescript", weight: 30, pattern: /\binterface\s+[A-Z]\w*\s*(<[^>]+>)?\s*\{/ },
  { lang: "typescript", weight: 30, pattern: /\btype\s+[A-Z]\w*\s*(<[^>]+>)?\s*=/ },
  { lang: "typescript", weight: 25, pattern: /\b(import|export)\s+type\s+/ },
  { lang: "typescript", weight: 20, pattern: /:\s*(string|number|boolean|void|any|never|unknown|Record<|Array<|Promise<)\b/ },
  { lang: "typescript", weight: 20, pattern: /\bas\s+(const|string|number|any|unknown)\b/ },
  { lang: "typescript", weight: 20, pattern: /\benum\s+[A-Z]\w*\s*\{/ },
  { lang: "typescript", weight: 15, pattern: /\b(private|protected|public|readonly)\s+\w+/ },

  // JavaScript
  { lang: "javascript", weight: 20, pattern: /\b(const|let|var)\s+\w+\s*=/ },
  { lang: "javascript", weight: 20, pattern: /\bfunction(\s+\w+)?\s*\([^)]*\)\s*\{/ },
  { lang: "javascript", weight: 18, pattern: /=>\s*\{/ },
  { lang: "javascript", weight: 18, pattern: /\bconsole\.(log|warn|error|info|debug)\s*\(/ },
  { lang: "javascript", weight: 18, pattern: /\b(import\s+.*\s+from\s+['"]|export\s+(default|const|function|class)\b)/ },
  { lang: "javascript", weight: 15, pattern: /\b(require\s*\(['"][^'"]+['"]\)|module\.exports\s*=)/ },
  { lang: "javascript", weight: 12, pattern: /\b(async\s+function|await\s+\w+|new\s+Promise\b)/ },

  // Python
  { lang: "python", weight: 30, pattern: /^\s*def\s+\w+\s*\([^)]*\)\s*:/m },
  { lang: "python", weight: 30, pattern: /^\s*class\s+\w+(\([^)]*\))?\s*:/m },
  { lang: "python", weight: 25, pattern: /^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+)/m },
  { lang: "python", weight: 20, pattern: /if\s+__name__\s*==\s*['"]__main__['"]\s*:/ },
  { lang: "python", weight: 15, pattern: /\b(elif|except|finally)\s*.*:/ },
  { lang: "python", weight: 15, pattern: /^\s*@\w+(\(.*\))?\s*$/m },
  { lang: "python", weight: 15, pattern: /\bself\.\w+/ },
  { lang: "python", weight: 15, pattern: /\bprint\s*\(/ },

  // YAML
  { lang: "yaml", weight: 30, pattern: /^---\s*$/m },
  { lang: "yaml", weight: 18, pattern: /^[\w-]+:\s+[^\n]+/m },
  { lang: "yaml", weight: 18, pattern: /^\s+-\s+[\w-]+:\s*/m },
  { lang: "yaml", weight: 15, pattern: /^[\w-]+:\s*$/m },

  // Markdown
  { lang: "markdown", weight: 25, pattern: /^#{1,6}\s+.+$/m },
  { lang: "markdown", weight: 25, pattern: /^```[a-zA-Z0-9_-]*$/m },
  { lang: "markdown", weight: 20, pattern: /\[[^\]]+\]\(https?:\/\/[^)]+\)/ },
  { lang: "markdown", weight: 15, pattern: /^\|\s*[^|]+\s*\|\s*[^|]+\s*\|/m },
  { lang: "markdown", weight: 12, pattern: /^\s*[-*]\s+.+$/m },

  // Shell / Bash
  { lang: "shell", weight: 40, pattern: /^#!\/(bin|usr)\/(env\s+)?(bash|sh|zsh)/m },
  { lang: "shell", weight: 20, pattern: /\b(echo|chmod|chown|mkdir|rm\s+-rf|sudo|brew|apt|curl|wget)\s+/ },
  { lang: "shell", weight: 20, pattern: /\b(npm|yarn|pnpm|git)\s+(install|run|build|commit|push|pull|clone|checkout)\b/ },
  { lang: "shell", weight: 15, pattern: /\bexport\s+[A-Z_][A-Z0-9_]*=/ },
  { lang: "shell", weight: 15, pattern: /\$\{[A-Z_][A-Z0-9_]*\}/ },

  // Go
  { lang: "go", weight: 35, pattern: /\bpackage\s+(main|[a-zA-Z0-9_]+)\b/ },
  { lang: "go", weight: 30, pattern: /\bfunc\s+(\([^)]+\)\s+)?\w+\s*\([^)]*\)\s*(\([a-zA-Z0-9_,\s*]+\)|[a-zA-Z0-9_*]+)?\s*\{/ },
  { lang: "go", weight: 25, pattern: /\bfmt\.(Print|Println|Printf|Sprintf|Errorf)\s*\(/ },
  { lang: "go", weight: 20, pattern: /:=\s*/ },
  { lang: "go", weight: 20, pattern: /\bgo\s+func\s*\(/ },

  // Rust
  { lang: "rust", weight: 35, pattern: /\bfn\s+\w+\s*(<[^>]+>)?\s*\([^)]*\)\s*(->\s*[^{]+)?\s*\{/ },
  { lang: "rust", weight: 30, pattern: /\blet\s+mut\s+\w+/ },
  { lang: "rust", weight: 25, pattern: /\b(pub\s+)?(impl|struct|enum|trait)\s+\w+/ },
  { lang: "rust", weight: 25, pattern: /\bprintln!\s*\(/ },
  { lang: "rust", weight: 20, pattern: /\buse\s+std::/ },
  { lang: "rust", weight: 20, pattern: /\bmatch\s+\w+\s*\{/ },

  // Java
  { lang: "java", weight: 35, pattern: /\bpublic\s+(final\s+|abstract\s+)?(class|interface)\s+\w+/ },
  { lang: "java", weight: 35, pattern: /\bpublic\s+static\s+void\s+main\s*\(\s*String\s*\[\s*\]/ },
  { lang: "java", weight: 25, pattern: /\bSystem\.out\.(print|println)\s*\(/ },
  { lang: "java", weight: 25, pattern: /\bpackage\s+[\w.]+;/ },
  { lang: "java", weight: 20, pattern: /\bimport\s+java\./ },
  { lang: "java", weight: 20, pattern: /@Override\b/ },

  // C#
  { lang: "csharp", weight: 35, pattern: /\busing\s+System(\.[\w.]+)?;/ },
  { lang: "csharp", weight: 30, pattern: /\bnamespace\s+[\w.]+/ },
  { lang: "csharp", weight: 30, pattern: /\bConsole\.(WriteLine|Write)\s*\(/ },
  { lang: "csharp", weight: 25, pattern: /\bpublic\s+async\s+Task(<[^>]+>)?\s+\w+/ },
  { lang: "csharp", weight: 20, pattern: /\{\s*get;\s*set;\s*\}/ },

  // PHP
  { lang: "php", weight: 40, pattern: /<\?php\b/ },
  { lang: "php", weight: 25, pattern: /\$[a-zA-Z_][a-zA-Z0-9_]*\s*=/ },
  { lang: "php", weight: 20, pattern: /\$this->/ },
  { lang: "php", weight: 20, pattern: /\bfunction\s+\w+\s*\([^)]*\$[a-zA-Z_]/ },

  // Ruby
  { lang: "ruby", weight: 30, pattern: /\bdef\s+\w+\b.*\n[\s\S]*?\bend\b/m },
  { lang: "ruby", weight: 25, pattern: /\battr_(accessor|reader|writer)\s+:[a-zA-Z_]/ },
  { lang: "ruby", weight: 20, pattern: /\bputs\s+["']/ },
  { lang: "ruby", weight: 20, pattern: /\brequire\s+["'][\w/.-]+["']/ },

  // Swift
  { lang: "swift", weight: 35, pattern: /\bimport\s+(UIKit|SwiftUI|Foundation)\b/ },
  { lang: "swift", weight: 25, pattern: /\bfunc\s+\w+\s*\([^)]*\)\s*->\s*\w+/ },
  { lang: "swift", weight: 25, pattern: /\bguard\s+let\s+\w+\s*=\s*/ },

  // Kotlin
  { lang: "kotlin", weight: 35, pattern: /\bfun\s+\w+\s*\([^)]*\)\s*(:\s*\w+)?\s*\{/ },
  { lang: "kotlin", weight: 25, pattern: /\bdata\s+class\s+\w+/ },
  { lang: "kotlin", weight: 20, pattern: /\bval\s+\w+\s*:\s*\w+/ },
];

/**
 * Score a single string against language heuristics and parsers.
 */
function scoreContent(content: string): Map<string, number> {
  const scores = new Map<string, number>();
  const trimmed = content.trim();
  if (trimmed.length < 5) return scores;

  // 1. JSON Syntactic Validation
  const startsJson = (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
                     (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (startsJson) {
    try {
      JSON.parse(trimmed);
      scores.set("json", (scores.get("json") || 0) + 120);
    } catch {
      // Try repair parse
      const repaired = parseJsonRobust(trimmed);
      if (repaired.data && !repaired.error) {
        scores.set("json", (scores.get("json") || 0) + 90);
      } else {
        // Looks like JSON structure even if invalid/partial
        scores.set("json", (scores.get("json") || 0) + 30);
      }
    }
  } else if (/"[^"]+"\s*:\s*("[^"]*"|\d+|true|false|null|[[{])/i.test(trimmed)) {
    scores.set("json", (scores.get("json") || 0) + 35);
  }

  // 2. XML / SVG Syntactic Validation
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const isExplicitXml = /^<\?xml\b/i.test(trimmed) || /<svg\b/i.test(trimmed);
    const hasHtmlDoctype = /<!DOCTYPE\s+html/i.test(trimmed);
    if (isExplicitXml && !hasHtmlDoctype) {
      scores.set("xml", (scores.get("xml") || 0) + 100);
    }
  }

  // 3. Regex Heuristics
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(content)) {
      scores.set(rule.lang, (scores.get(rule.lang) || 0) + rule.weight);
    }
  }

  // 4. Disambiguation adjustments
  // If TypeScript scored high, it also triggers JavaScript rules; give TypeScript the edge if TS-specific constructs exist
  const tsScore = scores.get("typescript") || 0;
  const jsScore = scores.get("javascript") || 0;
  if (tsScore >= 20 && jsScore > 0) {
    scores.set("typescript", tsScore + jsScore * 0.8);
  }

  // XML vs HTML
  const xmlScore = scores.get("xml") || 0;
  const htmlScore = scores.get("html") || 0;
  if (htmlScore > 0 && xmlScore > 0) {
    const hasHtmlTags = /<(html|head|body|div|span|p|a|table|form|input|button|script|style|link|meta)\b/i.test(trimmed);
    if (!hasHtmlTags) {
      scores.set("xml", xmlScore + htmlScore);
      scores.delete("html");
    }
  }

  return scores;
}

/**
 * Smartly detect the language from both Original and Modified inputs jointly.
 */
export function detectLanguageFromInputs(
  original: string,
  modified: string,
  threshold = 20
): DetectionResult {
  const origTrimmed = (original || "").trim();
  const modTrimmed = (modified || "").trim();

  // If both are empty or trivial, return plaintext
  if (origTrimmed.length < 5 && modTrimmed.length < 5) {
    return {
      language: "plaintext",
      label: "Plain Text",
      confidence: 0,
      reason: "Content is empty or too short",
    };
  }

  const combinedScores = new Map<string, number>();

  // Helper to add scores
  const merge = (scores: Map<string, number>, weightMultiplier = 1) => {
    for (const [lang, score] of scores) {
      combinedScores.set(lang, (combinedScores.get(lang) || 0) + score * weightMultiplier);
    }
  };

  if (origTrimmed.length >= 5) {
    merge(scoreContent(origTrimmed), 1.0);
  }

  if (modTrimmed.length >= 5) {
    merge(scoreContent(modTrimmed), 1.0);
  }

  if (combinedScores.size === 0) {
    return {
      language: "plaintext",
      label: "Plain Text",
      confidence: 0,
      reason: "No recognizable language pattern found",
    };
  }

  // Find the winning language
  let bestLang = "plaintext";
  let bestScore = 0;

  for (const [lang, score] of combinedScores) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  if (bestScore < threshold) {
    return {
      language: "plaintext",
      label: "Plain Text",
      confidence: Math.round(Math.min(100, (bestScore / threshold) * 40)),
      reason: "Confidence below detection threshold",
    };
  }

  // Calculate normalized confidence percentage
  const confidence = Math.min(99, Math.max(50, Math.round((bestScore / (bestScore + 15)) * 100)));
  const langInfo = getLanguageInfo(bestLang);

  return {
    language: bestLang,
    label: langInfo.label,
    confidence,
    reason: `Detected ${langInfo.label} with ${confidence}% confidence`,
  };
}
