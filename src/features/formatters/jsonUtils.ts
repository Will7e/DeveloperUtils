export interface JsonFormatOptions {
  tabSize: number;
  sortKeys: boolean;
}

export function parseJsonRobust(input: string): { data: any; error: string | null; errorLine?: number; errorCol?: number } {
  if (!input.trim()) return { data: null, error: null };

  try {
    const data = JSON.parse(input);
    return { data, error: null };
  } catch (err: any) {
    let errorMsg = err.message;
    let errorLine, errorCol;

    // Attempt to extract position info from standard JSON errors
    const match = errorMsg.match(/at position (\d+)/);
    if (match) {
      const pos = parseInt(match[1], 10);
      const lines = input.slice(0, pos).split('\n');
      errorLine = lines.length;
      errorCol = lines[lines.length - 1]!.length + 1;
      errorMsg = `${errorMsg.replace(/ at position \d+/, '')} (Line ${errorLine}, Col ${errorCol})`;
    }

    // Attempt auto-repair for common issues (trailing commas, comments, unquoted strings)
    try {
      let repaired = input
        .replace(/\/\/.*$/gm, '') // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
        .replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
        .replace(/:\s*(\d+\.\d+\.\d+[a-zA-Z0-9-]*)/g, ': "$1"') // Fix unquoted semver numbers
        .replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*[,}])/g, (match, p1) => {
          if (p1 === 'true' || p1 === 'false' || p1 === 'null') return match;
          return `: "${p1}"`;
        }) // Fix unquoted string values
        .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":'); // Fix unquoted keys

      const data = JSON.parse(repaired);
      return { data, error: null }; // Successfully repaired!
    } catch (e2) {
      // If basic repair fails, try a loose parsing strategy using Function
      // This handles single quotes and unquoted keys which are common when pasting JS objects.
      try {
        const func = new Function(`return (${input});`);
        const data = func();
        if (data !== undefined) {
          // If evaluated successfully, serialize and deserialize to ensure strict JSON validity
          const strictJsonData = JSON.parse(JSON.stringify(data));
          return { data: strictJsonData, error: null };
        }
      } catch (e3) {
        // Fall back to original error if all repair attempts fail
      }

      return { data: null, error: errorMsg, errorLine, errorCol };
    }
  }
}

export function formatJsonRobust(input: string, options: JsonFormatOptions): string {
  const { data, error } = parseJsonRobust(input);
  if (error || !data) {
    throw new Error(error || "Invalid JSON");
  }

  let formattedData = data;
  if (options.sortKeys) {
    formattedData = sortObjectKeys(formattedData);
  }

  return JSON.stringify(formattedData, null, options.tabSize);
}

function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sortedObj: any = {};
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    sortedObj[key] = sortObjectKeys(obj[key]);
  }

  return sortedObj;
}
