export interface JsonFormatOptions {
  tabSize: number;
  sortKeys: boolean;
}

export function parseJsonRobust(input: string): { data: unknown; error: string | null; errorLine?: number; errorCol?: number } {
  if (!input.trim()) return { data: null, error: null };

  try {
    const data = JSON.parse(input);
    return { data, error: null };
  } catch (err: unknown) {
    let errorMsg = err instanceof Error ? err.message : String(err);
    let errorLine: number | undefined;
    let errorCol: number | undefined;

    // Attempt to extract position info from standard JSON errors
    const match = errorMsg.match(/at position (\d+)/);
    if (match && match[1]) {
      const pos = parseInt(match[1], 10);
      const lines = input.slice(0, pos).split('\n');
      errorLine = lines.length;
      const lastLine = lines[lines.length - 1] ?? '';
      errorCol = lastLine.length + 1;
      errorMsg = `${errorMsg.replace(/ at position \d+/, '')} (Line ${errorLine}, Col ${errorCol})`;
    }

    // Attempt auto-repair for common issues (trailing commas, comments, single quotes, unquoted strings)
    try {
      const repaired = input
        .replace(/\/\/.*$/gm, '') // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"') // Replace single-quoted strings with double quotes
        .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
        .replace(/:\s*(\d+\.\d+\.\d+[a-zA-Z0-9-]*)/g, ': "$1"') // Fix unquoted semver numbers
        .replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*[,}])/g, (m, p1) => {
          if (p1 === 'true' || p1 === 'false' || p1 === 'null') return m;
          return `: "${p1}"`;
        }) // Fix unquoted string values
        .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":'); // Fix unquoted keys

      const data = JSON.parse(repaired);
      return { data, error: null }; // Successfully repaired!
    } catch {
      return { data: null, error: errorMsg, errorLine, errorCol };
    }
  }
}

export function formatJsonRobust(input: string, options: JsonFormatOptions): string {
  const { data, error } = parseJsonRobust(input);
  if (error || !data) {
    throw new Error(error || "Invalid JSON");
  }

  let formattedData: unknown = data;
  if (options.sortKeys) {
    formattedData = sortObjectKeys(formattedData);
  }

  return JSON.stringify(formattedData, null, options.tabSize);
}

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const record = obj as Record<string, unknown>;
  const sortedObj: Record<string, unknown> = {};
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    sortedObj[key] = sortObjectKeys(record[key]);
  }

  return sortedObj;
}
