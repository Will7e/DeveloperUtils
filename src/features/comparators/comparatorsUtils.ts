// ============================================================
// comparatorsUtils.ts — Core comparison engines & sanitizers
// Handles List & Set operations, Semantic JSON diffing,
// and Key-Value / .env config analysis.
// ============================================================

// ------------------------------------------------------------
// 1. LIST & SET COMPARISON UTILITIES
// ------------------------------------------------------------

export interface ListCompareOptions {
  caseSensitive: boolean;
  trimWhitespace: boolean;
  sortAlpha: boolean;
  stripQuotes?: boolean;
}

export interface ListCompareResult {
  aOnly: string[];
  bOnly: string[];
  both: string[];
  union: string[];
  countA: number;
  countB: number;
  totalUnique: number;
}

/**
 * Parses raw text into a cleaned, unique list of string items.
 * Supports auto-detecting delimiters (newlines, commas, semicolons, pipes, tabs)
 * and strips wrapping quotes ('abc', "abc").
 */
export function processRawList(
  input: string,
  options: { trimWhitespace?: boolean; stripQuotes?: boolean } = {}
): string[] {
  if (!input || !input.trim()) return [];

  const { trimWhitespace = true, stripQuotes = true } = options;

  // Split by newlines, carriage returns, commas, semicolons, tabs, and pipes
  const rawTokens = input.split(/[\r\n,;|]+/);
  const result: string[] = [];
  const seen = new Set<string>();

  for (let token of rawTokens) {
    if (trimWhitespace) {
      token = token.trim();
    }
    if (stripQuotes && token.length >= 2) {
      if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'")) ||
        (token.startsWith("`") && token.endsWith("`"))
      ) {
        token = token.slice(1, -1);
        if (trimWhitespace) {
          token = token.trim();
        }
      }
    }

    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }

  return result;
}

export function compareLists(
  inputA: string,
  inputB: string,
  options: ListCompareOptions
): ListCompareResult {
  const listA = processRawList(inputA, {
    trimWhitespace: options.trimWhitespace,
    stripQuotes: options.stripQuotes ?? true,
  });
  const listB = processRawList(inputB, {
    trimWhitespace: options.trimWhitespace,
    stripQuotes: options.stripQuotes ?? true,
  });

  const mapA = new Map<string, string>();
  for (const item of listA) {
    const key = options.caseSensitive ? item : item.toLowerCase();
    if (!mapA.has(key)) mapA.set(key, item);
  }

  const mapB = new Map<string, string>();
  for (const item of listB) {
    const key = options.caseSensitive ? item : item.toLowerCase();
    if (!mapB.has(key)) mapB.set(key, item);
  }

  const aOnly: string[] = [];
  const both: string[] = [];
  const bOnly: string[] = [];
  const unionSet = new Set<string>();

  for (const item of listA) {
    const key = options.caseSensitive ? item : item.toLowerCase();
    unionSet.add(item);
    if (mapB.has(key)) {
      both.push(item);
    } else {
      aOnly.push(item);
    }
  }

  for (const item of listB) {
    const key = options.caseSensitive ? item : item.toLowerCase();
    unionSet.add(item);
    if (!mapA.has(key)) {
      bOnly.push(item);
    }
  }

  if (options.sortAlpha) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    aOnly.sort(collator.compare);
    bOnly.sort(collator.compare);
    both.sort(collator.compare);
  }

  const union = Array.from(unionSet);
  if (options.sortAlpha) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    union.sort(collator.compare);
  }

  return {
    aOnly,
    bOnly,
    both,
    union,
    countA: listA.length,
    countB: listB.length,
    totalUnique: union.length,
  };
}

// ------------------------------------------------------------
// 2. SEMANTIC JSON & DEEP OBJECT COMPARISON UTILITIES
// ------------------------------------------------------------

export type JsonDiffType = "added" | "removed" | "modified" | "type_changed" | "unchanged";

export interface JsonDiffItem {
  id: string;
  path: string;
  type: JsonDiffType;
  leftValue?: unknown;
  rightValue?: unknown;
  leftType?: string;
  rightType?: string;
}

export interface JsonDiffResult {
  items: JsonDiffItem[];
  stats: {
    added: number;
    removed: number;
    modified: number;
    typeChanged: number;
    unchanged: number;
    total: number;
  };
}

/**
 * Lenient JSON parser that handles common trailing commas and formatting quirks.
 */
export function parseJsonLenient(raw: string): { success: true; data: unknown } | { success: false; error: string } {
  if (!raw || !raw.trim()) {
    return { success: true, data: undefined };
  }

  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return { success: true, data: parsed };
  } catch (initialErr) {
    // Attempt cleaning trailing commas: [1, 2,] or {"a": 1,}
    try {
      const sanitized = trimmed.replace(/,\s*([}\]])/g, "$1");
      const parsed = JSON.parse(sanitized);
      return { success: true, data: parsed };
    } catch {
      return {
        success: false,
        error: initialErr instanceof Error ? initialErr.message : "Invalid JSON syntax",
      };
    }
  }
}

function getDetailedType(val: unknown): string {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}

/**
 * Recursively deep-compares two JSON objects or arrays and returns granular diff items.
 */
export function deepCompareJson(left: unknown, right: unknown, includeUnchanged = false): JsonDiffResult {
  const items: JsonDiffItem[] = [];

  const stats = {
    added: 0,
    removed: 0,
    modified: 0,
    typeChanged: 0,
    unchanged: 0,
    total: 0,
  };

  if (left === undefined && right === undefined) {
    return { items, stats };
  }

  let counter = 0;

  function traverse(currentLeft: unknown, currentRight: unknown, path: string) {
    const leftType = getDetailedType(currentLeft);
    const rightType = getDetailedType(currentRight);

    // 1. Right exists, left missing -> ADDED
    if (currentLeft === undefined && currentRight !== undefined) {
      counter++;
      stats.added++;
      stats.total++;
      items.push({
        id: `diff-${counter}`,
        path: path || "(root)",
        type: "added",
        rightValue: currentRight,
        rightType,
      });
      return;
    }

    // 2. Left exists, right missing -> REMOVED
    if (currentLeft !== undefined && currentRight === undefined) {
      counter++;
      stats.removed++;
      stats.total++;
      items.push({
        id: `diff-${counter}`,
        path: path || "(root)",
        type: "removed",
        leftValue: currentLeft,
        leftType,
      });
      return;
    }

    // 3. Type mutation -> TYPE_CHANGED
    if (leftType !== rightType) {
      counter++;
      stats.typeChanged++;
      stats.total++;
      items.push({
        id: `diff-${counter}`,
        path: path || "(root)",
        type: "type_changed",
        leftValue: currentLeft,
        rightValue: currentRight,
        leftType,
        rightType,
      });
      return;
    }

    // 4. Arrays
    if (leftType === "array" && rightType === "array") {
      const arrL = currentLeft as unknown[];
      const arrR = currentRight as unknown[];
      const maxLen = Math.max(arrL.length, arrR.length);

      for (let i = 0; i < maxLen; i++) {
        const itemPath = path ? `${path}[${i}]` : `[${i}]`;
        traverse(arrL[i], arrR[i], itemPath);
      }
      return;
    }

    // 5. Objects
    if (leftType === "object" && rightType === "object") {
      const objL = currentLeft as Record<string, unknown>;
      const objR = currentRight as Record<string, unknown>;
      const allKeys = Array.from(new Set([...Object.keys(objL), ...Object.keys(objR)]));
      allKeys.sort();

      for (const key of allKeys) {
        const itemPath = path ? `${path}.${key}` : key;
        traverse(objL[key], objR[key], itemPath);
      }
      return;
    }

    // 6. Primitives comparison
    if (currentLeft !== currentRight) {
      counter++;
      stats.modified++;
      stats.total++;
      items.push({
        id: `diff-${counter}`,
        path: path || "(root)",
        type: "modified",
        leftValue: currentLeft,
        rightValue: currentRight,
        leftType,
        rightType,
      });
    } else if (includeUnchanged) {
      counter++;
      stats.unchanged++;
      stats.total++;
      items.push({
        id: `diff-${counter}`,
        path: path || "(root)",
        type: "unchanged",
        leftValue: currentLeft,
        rightValue: currentRight,
        leftType,
        rightType,
      });
    }
  }

  traverse(left, right, "");
  return { items, stats };
}

// ------------------------------------------------------------
// 3. KEY-VALUE & .ENV CONFIG COMPARISON UTILITIES
// ------------------------------------------------------------

export type EnvDiffType = "missing_in_b" | "missing_in_a" | "mismatch" | "matched";

export interface EnvDiffItem {
  key: string;
  status: EnvDiffType;
  valueA?: string;
  valueB?: string;
  comment?: string;
}

export interface EnvDiffResult {
  items: EnvDiffItem[];
  stats: {
    missingInB: number;
    missingInA: number;
    mismatch: number;
    matched: number;
    total: number;
  };
}

/**
 * Parses raw .env or properties file into key-value map.
 * Safely handles quotes, inline comments, and whitespace.
 */
export function parseEnvContent(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  const lines = raw.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    // KEY=VALUE or KEY: VALUE
    const eqIdx = line.indexOf("=");
    const colonIdx = line.indexOf(":");
    let separatorIdx = -1;

    if (eqIdx !== -1 && (colonIdx === -1 || eqIdx < colonIdx)) {
      separatorIdx = eqIdx;
    } else if (colonIdx !== -1) {
      separatorIdx = colonIdx;
    }

    if (separatorIdx === -1) continue;

    let key = line.slice(0, separatorIdx).trim();
    let value = line.slice(separatorIdx + 1).trim();

    // Strip "export " prefix if present (e.g. export PORT=3000)
    if (key.startsWith("export ")) {
      key = key.slice(7).trim();
    }

    // Strip wrapping quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      map.set(key, value);
    }
  }

  return map;
}

export function compareEnvs(rawA: string, rawB: string): EnvDiffResult {
  const mapA = parseEnvContent(rawA);
  const mapB = parseEnvContent(rawB);

  const allKeys = Array.from(new Set([...mapA.keys(), ...mapB.keys()]));
  allKeys.sort();

  const items: EnvDiffItem[] = [];
  const stats = {
    missingInB: 0,
    missingInA: 0,
    mismatch: 0,
    matched: 0,
    total: allKeys.length,
  };

  for (const key of allKeys) {
    const hasA = mapA.has(key);
    const hasB = mapB.has(key);
    const valA = mapA.get(key);
    const valB = mapB.get(key);

    if (hasA && !hasB) {
      stats.missingInB++;
      items.push({ key, status: "missing_in_b", valueA: valA });
    } else if (!hasA && hasB) {
      stats.missingInA++;
      items.push({ key, status: "missing_in_a", valueB: valB });
    } else if (valA !== valB) {
      stats.mismatch++;
      items.push({ key, status: "mismatch", valueA: valA, valueB: valB });
    } else {
      stats.matched++;
      items.push({ key, status: "matched", valueA: valA, valueB: valB });
    }
  }

  return { items, stats };
}

export function maskValue(val?: string): string {
  if (val === undefined) return "";
  if (val.length <= 4) return "••••";
  return "••••••••";
}

// ------------------------------------------------------------
// 4. REALISTIC SAMPLE PRESETS
// ------------------------------------------------------------

export const COMPARATOR_SAMPLES = {
  list: {
    a: `usr_10928374
usr_20918273
usr_30192847
usr_49182736
usr_50192837
usr_61029384
usr_71928301`,
    b: `usr_20918273
usr_49182736
usr_61029384
usr_80192834
usr_91029381`,
  },
  json: {
    a: JSON.stringify(
      {
        service: "user-auth-api",
        version: "2.4.0",
        port: 8080,
        enabled: true,
        features: ["oauth2", "mfa", "audit-logs"],
        database: {
          host: "db.staging.internal",
          maxPool: 10,
          timeoutMs: "5000",
        },
        deprecatedEndpoint: "/v1/login",
      },
      null,
      2
    ),
    b: JSON.stringify(
      {
        service: "user-auth-api",
        version: "2.5.0",
        port: 8080,
        enabled: true,
        features: ["oauth2", "mfa", "audit-logs", "passkeys"],
        database: {
          host: "db.prod.internal",
          maxPool: 25,
          timeoutMs: 5000,
        },
        rateLimiter: {
          rpm: 1200,
          burst: 200,
        },
      },
      null,
      2
    ),
  },
  env: {
    a: `# Development Environment Config
PORT=3000
NODE_ENV=development
API_BASE_URL=https://api-dev.company.com
DATABASE_URL=postgres://dev_user:password123@localhost:5432/main_db
JWT_SECRET=super-secret-dev-token-99
CACHE_TTL_SECONDS=300
ENABLE_DEBUG_METRICS=true
LEGACY_FLAG_ENABLED=true`,
    b: `# Production Environment Config
PORT=8080
NODE_ENV=production
API_BASE_URL=https://api.company.com
DATABASE_URL=postgres://prod_user:p@ssw0rdProd!@db-prod.aws.com:5432/main_db
JWT_SECRET=super-secret-prod-token-2026
CACHE_TTL_SECONDS=3600
ENABLE_DEBUG_METRICS=false
SENTRY_DSN=https://abc123xyz@o9999.ingest.sentry.io/45000`,
  },
};
