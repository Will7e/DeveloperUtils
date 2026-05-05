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
      const lastLine = lines[lines.length - 1];
      errorCol = (lastLine ? lastLine.length : 0) + 1;
      errorMsg = `${errorMsg.replace(/ at position \d+/, '')} (Line ${errorLine}, Col ${errorCol})`;
    }
    
    // Attempt auto-repair for common issues (trailing commas, comments, unquoted strings, single quotes)
    try {
      // We use a pattern to match valid double-quoted strings first, so we can ignore them when replacing
      // This prevents corrupting strings that contain URLs, commas, or look like unquoted keys
      const strPattern = '("(?:\\\\[\\s\\S]|[^"])*")';
      
      let repaired = input
        // 1. Remove comments
        .replace(new RegExp(`${strPattern}|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/.*$`, 'gm'), (m, str) => str ? str : '')
        // 2. Convert single quotes to double quotes
        .replace(new RegExp(`${strPattern}|\\'([^\\'\\\\]*(?:\\\\.[^\\'\\\\]*)*)\\'`, 'g'), (m, str, sQuoted) => {
          if (str) return str;
          return `"${sQuoted.replace(/"/g, '\\"')}"`;
        })
        // 3. Remove trailing commas
        .replace(new RegExp(`${strPattern}|,\\s*([\\}\\]])`, 'g'), (m, str, closeBracket) => str ? str : closeBracket)
        // 4. Fix unquoted semver numbers
        .replace(new RegExp(`${strPattern}|:\\s*(\\d+\\.\\d+\\.\\d+[a-zA-Z0-9-]*)`, 'g'), (m, str, semver) => str ? str : `: "${semver}"`)
        // 5. Fix unquoted string values
        .replace(new RegExp(`${strPattern}|:\\s*([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\\s*[,\\}])`, 'g'), (m, str, val) => {
          if (str) return str;
          if (val === 'true' || val === 'false' || val === 'null') return m;
          return `: "${val}"`;
        })
        // 6. Fix unquoted keys
        .replace(new RegExp(`${strPattern}|([\\{\\,]\\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*:`, 'g'), (m, str, prefix, key) => {
          return str ? str : `${prefix}"${key}":`;
        });
      
      const data = JSON.parse(repaired);
      return { data, error: null }; // Successfully repaired!
    } catch (e2) {
      // Fall back to original error if all repair attempts fail
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
