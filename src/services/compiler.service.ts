// ============================================================
// Compiler Service — Production-grade browser-based execution
// ============================================================
// Execution strategy:
//   • JavaScript  → Web Worker sandbox (isolated, with timeout)
//   • TypeScript  → Real TS compiler (CDN) → Web Worker sandbox
//   • Python      → Pyodide WASM (in-page, with timeout wrapper)
//   • HTML        → Preview stub (rendered in iframe elsewhere)
//   • SQL         → SQLite WASM (official @sqlite.org build, in worker)
//   • Lua         → Lua 5.4 via wasmoon WASM (in worker)
//
// The Web Worker approach ensures:
//   1. Infinite-loop protection via configurable timeout
//   2. True sandbox — no DOM, window, localStorage access
//   3. Real cancellation via worker.terminate()
//   4. Non-blocking UI — execution never freezes the main thread
// ============================================================

import type { Language, ExecutionResult, ExecutionOptions, ICompilerService } from "@/types";

// ============================================================
// TypeScript Compiler (loaded from CDN on demand)
// ============================================================
type TSModule = typeof import("typescript");
let tsModule: TSModule | null = null;
let tsLoadPromise: Promise<TSModule> | null = null;

async function loadTypeScriptCompiler(): Promise<TSModule> {
  if (tsModule) return tsModule;
  if (tsLoadPromise) return tsLoadPromise;

  tsLoadPromise = new Promise((resolve, reject) => {
    try {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/typescript@5.5.4/lib/typescript.min.js";
      script.integrity = "sha384-ZpynyeRTntpnyPnOEFURvjfBRu26zrASCWaWwuvHYAxPh8s3xAuhKVVDj7TUoGRQ";
      script.crossOrigin = "anonymous";
      script.async = true;

      script.onload = () => {
        // TypeScript attaches itself to the global `ts` variable
        tsModule = (window as unknown as { ts?: TSModule }).ts || null;
        if (tsModule) {
          resolve(tsModule);
        } else {
          reject(new Error("TypeScript loaded but `ts` global not found"));
        }
      };

      script.onerror = () => {
        tsLoadPromise = null;
        reject(new Error("Failed to load TypeScript compiler from CDN. Please check your network connection."));
      };

      document.head.appendChild(script);
    } catch (err) {
      tsLoadPromise = null;
      reject(err);
    }
  });

  return tsLoadPromise;
}

/** Transpile TypeScript → JavaScript using the real TS compiler */
async function transpileTypeScript(
  code: string
): Promise<{ js: string; diagnostics: string[] }> {
  const ts = await loadTypeScriptCompiler();

  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      esModuleInterop: true,
      allowJs: true,
      declaration: false,
      sourceMap: false,
      removeComments: false,
    },
    reportDiagnostics: true,
  });

  const diagnostics = (result.diagnostics || []).map((d) =>
    typeof d.messageText === "string" ? d.messageText : ts.flattenDiagnosticMessageText(d.messageText, "\n")
  );

  return { js: result.outputText, diagnostics };
}

// ============================================================
// Web Worker Sandboxed Execution (JavaScript)
// ============================================================
let activeWorker: Worker | null = null;

/**
 * Execute JavaScript code inside a Web Worker sandbox.
 * - No access to DOM, window, document, localStorage
 * - Configurable timeout with automatic termination
 * - Cancellable via cancelWorkerExecution()
 */
function executeInWorker(
  code: string,
  timeout: number = 10000
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    // Build the worker script
    const workerScript = `
      'use strict';

      // ── Console capture ──────────────────────────────
      const __stdout = [];
      const __stderr = [];

      function __formatArg(arg) {
        if (arg === null) return 'null';
        if (arg === undefined) return 'undefined';
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.name + ': ' + arg.message;
        if (typeof arg === 'object') {
          try { return JSON.stringify(arg, null, 2); }
          catch { return String(arg); }
        }
        return String(arg);
      }

      const console = {
        log: (...args) => {
          __stdout.push(args.map(__formatArg).join(' '));
        },
        info: (...args) => {
          __stdout.push(args.map(__formatArg).join(' '));
        },
        warn: (...args) => {
          __stderr.push('[warn] ' + args.map(__formatArg).join(' '));
        },
        error: (...args) => {
          __stderr.push(args.map(__formatArg).join(' '));
        },
        debug: (...args) => {
          __stdout.push('[debug] ' + args.map(__formatArg).join(' '));
        },
        table: (data) => {
          __stdout.push(JSON.stringify(data, null, 2));
        },
        clear: () => {
          __stdout.length = 0;
          __stderr.length = 0;
        },
        dir: (obj) => {
          __stdout.push(JSON.stringify(obj, null, 2));
        },
        time: (() => {
          const timers = {};
          return (label = 'default') => { timers[label] = performance.now(); };
        })(),
        timeEnd: (() => {
          const timers = {};
          return (label = 'default') => {
            const start = timers[label];
            if (start !== undefined) {
              __stdout.push(label + ': ' + (performance.now() - start).toFixed(3) + 'ms');
              delete timers[label];
            }
          };
        })(),
        assert: (condition, ...args) => {
          if (!condition) {
            __stderr.push('Assertion failed: ' + args.map(__formatArg).join(' '));
          }
        },
        count: (() => {
          const counts = {};
          return (label = 'default') => {
            counts[label] = (counts[label] || 0) + 1;
            __stdout.push(label + ': ' + counts[label]);
          };
        })(),
        group: () => {},
        groupEnd: () => {},
      };

      // ── Block dangerous globals on self/globalThis ──────────────────────
      const document = undefined;
      const window = undefined;
      const localStorage = undefined;
      const sessionStorage = undefined;
      const XMLHttpRequest = undefined;
      const fetch = globalThis.fetch; // Allow fetch for API calls

      const __blockedGlobals = [
        'indexedDB', 'importScripts', 'caches', 'cookieStore',
        'SharedWorker', 'ServiceWorker', 'BroadcastChannel'
      ];
      for (const __prop of __blockedGlobals) {
        try {
          Object.defineProperty(globalThis, __prop, { value: undefined, configurable: false, writable: false });
        } catch {}
      }

      // Safe communication channel isolated from user overrides
      const __safePostMessage = postMessage.bind(globalThis);
      try {
        Object.defineProperty(globalThis, 'postMessage', { value: undefined, configurable: false, writable: false });
      } catch {}

      // ── Execute ──────────────────────────────────────
      const __startTime = performance.now();

      try {
        // Wrap in an async IIFE so top-level await works
        const __asyncFn = new Function(
          'console', 'fetch',
          '"use strict"; return (async () => {\\n' + ${JSON.stringify(code)} + '\\n})();'
        );
        __asyncFn(console, fetch).then(() => {
          const __duration = performance.now() - __startTime;
          __safePostMessage({
            stdout: __stdout.join('\\n'),
            stderr: __stderr.join('\\n'),
            exitCode: 0,
            duration: __duration,
          });
        }).catch((err) => {
          const __duration = performance.now() - __startTime;
          const errorMsg = err instanceof Error
            ? err.name + ': ' + err.message
            : String(err);
          __safePostMessage({
            stdout: __stdout.join('\\n'),
            stderr: __stderr.length > 0
              ? __stderr.join('\\n') + '\\n' + errorMsg
              : errorMsg,
            exitCode: 1,
            duration: __duration,
          });
        });
      } catch (err) {
        const __duration = performance.now() - __startTime;
        const errorMsg = err instanceof Error
          ? err.name + ': ' + err.message
          : String(err);
        __safePostMessage({
          stdout: __stdout.join('\\n'),
          stderr: __stderr.length > 0
            ? __stderr.join('\\n') + '\\n' + errorMsg
            : errorMsg,
          exitCode: 1,
          duration: __duration,
        });
      }
    `;

    const blob = new Blob([workerScript], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);

    // Track for cancellation
    activeWorker = worker;

    let resolved = false;

    // Timeout handler
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      worker.terminate();
      activeWorker = null;
      URL.revokeObjectURL(blobUrl);
      resolve({
        stdout: "",
        stderr: `⏱ Execution timed out after ${(timeout / 1000).toFixed(0)}s\n\nTip: You can increase the timeout in Settings, or check your code for infinite loops.`,
        exitCode: 1,
        duration: timeout,
        timestamp: Date.now(),
      });
    }, timeout);

    // Result handler
    worker.onmessage = (e: MessageEvent) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      worker.terminate();
      activeWorker = null;
      URL.revokeObjectURL(blobUrl);

      const data = e.data;
      resolve({
        stdout: (data.stdout || "").trimEnd(),
        stderr: (data.stderr || "").trimEnd(),
        exitCode: data.exitCode,
        duration: data.duration,
        timestamp: Date.now(),
      });
    };

    // Worker error handler
    worker.onerror = (e: ErrorEvent) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      worker.terminate();
      activeWorker = null;
      URL.revokeObjectURL(blobUrl);

      resolve({
        stdout: "",
        stderr: `Worker error: ${e.message || "Unknown error"}`,
        exitCode: 1,
        duration: 0,
        timestamp: Date.now(),
      });
    };
  });
}

/** Cancel any running Worker execution */
function cancelWorkerExecution(): boolean {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
    return true;
  }
  return false;
}

// ============================================================
// Language Executors
// ============================================================

/** Execute JavaScript in a sandboxed Web Worker */
async function executeJavaScript(
  code: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeout = options?.timeout ?? 10000;
  return executeInWorker(code, timeout);
}

/** Execute TypeScript: real compilation → Web Worker */
async function executeTypeScript(
  code: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeout = options?.timeout ?? 10000;

  try {
    // Transpile TS → JS using the real TypeScript compiler
    const { js, diagnostics } = await transpileTypeScript(code);

    // Report any compilation warnings/errors but still execute
    let warnings = "";
    if (diagnostics.length > 0) {
      warnings = diagnostics.map((d) => `[TS] ${d}`).join("\n");
    }

    const result = await executeInWorker(js, timeout);

    // Prepend TS diagnostics as warnings in stderr
    if (warnings && result.stderr) {
      result.stderr = `${warnings}\n\n${result.stderr}`;
    } else if (warnings) {
      result.stderr = warnings;
    }

    return result;
  } catch (error) {
    // TypeScript compiler itself failed to load or transpile
    return {
      stdout: "",
      stderr: `TypeScript compilation failed: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      duration: 0,
      timestamp: Date.now(),
    };
  }
}

// ============================================================
// Pyodide (Python WASM) Web Worker Sandboxed Engine
// ============================================================
// Completely isolated from the main thread DOM, window, document,
// and localStorage. Infinite loops and CPU-heavy scripts can be
// cancelled via worker.terminate() without freezing the UI.
// ============================================================

let activePythonWorker: Worker | null = null;
let pythonWorkerBlobUrl: string | null = null;
let isPythonReady = false;

const PYODIDE_WORKER_CODE = `
  'use strict';
  let pyodide = null;
  let pyodideReadyPromise = null;

  // ── Block dangerous globals on self/globalThis ──────────────────
  const __blockedGlobals = [
    'indexedDB', 'caches', 'cookieStore',
    'SharedWorker', 'ServiceWorker', 'BroadcastChannel'
  ];
  for (const __prop of __blockedGlobals) {
    try {
      Object.defineProperty(globalThis, __prop, { value: undefined, configurable: false, writable: false });
    } catch {}
  }

  async function getOrInitPyodide() {
    if (pyodide) return pyodide;
    if (pyodideReadyPromise) return pyodideReadyPromise;

    pyodideReadyPromise = (async () => {
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js');
      pyodide = await self.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/'
      });
      return pyodide;
    })();

    return pyodideReadyPromise;
  }

  self.onmessage = async (e) => {
    const data = e.data;
    if (data.type === 'init') {
      try {
        await getOrInitPyodide();
        self.postMessage({ type: 'init_done' });
      } catch (err) {
        self.postMessage({ type: 'init_error', error: String(err) });
      }
      return;
    }

    if (data.type === 'execute') {
      const { id, code } = data;
      const startTime = performance.now();
      try {
        const engine = await getOrInitPyodide();

        // Capture Python stdout/stderr via StringIO
        engine.runPython(\`
import sys
from io import StringIO
sys.stdout = StringIO()
sys.stderr = StringIO()
\`);

        try {
          await engine.runPythonAsync(code);
        } catch (runErr) {
          const stdout = String(engine.runPython("sys.stdout.getvalue()") || "");
          const stderr = runErr instanceof Error ? runErr.message : String(runErr);
          const duration = performance.now() - startTime;
          self.postMessage({ type: 'result', id, stdout, stderr, exitCode: 1, duration });
          return;
        }

        const stdout = String(engine.runPython("sys.stdout.getvalue()") || "");
        const stderr = String(engine.runPython("sys.stderr.getvalue()") || "");
        const duration = performance.now() - startTime;

        self.postMessage({
          type: 'result',
          id,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          exitCode: 0,
          duration
        });
      } catch (err) {
        const duration = performance.now() - startTime;
        const stderr = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: 'result', id, stdout: '', stderr, exitCode: 1, duration });
      }
    }
  };
`;

function getOrCreatePythonWorker(): Worker {
  if (activePythonWorker) return activePythonWorker;

  if (!pythonWorkerBlobUrl) {
    const blob = new Blob([PYODIDE_WORKER_CODE], { type: "application/javascript" });
    pythonWorkerBlobUrl = URL.createObjectURL(blob);
  }

  activePythonWorker = new Worker(pythonWorkerBlobUrl);
  return activePythonWorker;
}

async function initPython(): Promise<void> {
  if (isPythonReady) return;
  return new Promise((resolve, reject) => {
    const worker = getOrCreatePythonWorker();
    const handleInit = (e: MessageEvent) => {
      if (e.data.type === "init_done") {
        isPythonReady = true;
        worker.removeEventListener("message", handleInit);
        resolve();
      } else if (e.data.type === "init_error") {
        worker.removeEventListener("message", handleInit);
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener("message", handleInit);
    worker.postMessage({ type: "init" });
  });
}

/** Execute Python inside a dedicated, isolated Web Worker sandbox */
async function executePython(
  code: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeout = options?.timeout ?? 30000;
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const worker = getOrCreatePythonWorker();
    const execId = Math.random().toString(36).substring(2);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // True infinite-loop cancellation via worker.terminate()
      if (activePythonWorker) {
        activePythonWorker.terminate();
        activePythonWorker = null;
        isPythonReady = false;
      }
      resolve({
        stdout: "",
        stderr: `⏱ Python execution timed out after ${(timeout / 1000).toFixed(0)}s\n\nTip: You can increase the timeout in Settings, or check your code for infinite loops.`,
        exitCode: 1,
        duration: timeout,
        timestamp: Date.now(),
      });
    }, timeout);

    const handleMessage = (e: MessageEvent) => {
      if (resolved) return;
      if (e.data.type === "result" && e.data.id === execId) {
        resolved = true;
        cleanup();
        resolve({
          stdout: e.data.stdout || "",
          stderr: e.data.stderr || "",
          exitCode: e.data.exitCode ?? 0,
          duration: e.data.duration ?? 0,
          timestamp: Date.now(),
        });
      }
    };

    const handleError = (e: ErrorEvent) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        stdout: "",
        stderr: `Python worker error: ${e.message || "Unknown error"}`,
        exitCode: 1,
        duration: 0,
        timestamp: Date.now(),
      });
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ type: "execute", id: execId, code });
  });
}

// ============================================================
// SQL (SQLite WASM) Web Worker Sandboxed Engine
// ============================================================
// Official @sqlite.org/sqlite-wasm build running in an isolated
// module worker. The script is split into individual statements so
// SELECT results can be rendered as per-statement ASCII tables.
// Infinite loops in triggers / pathological queries are cancelled
// via worker.terminate() without freezing the UI.
// ============================================================

const SQLITE_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.53.4-build1/dist/index.mjs";

let activeSqlWorker: Worker | null = null;
let sqlWorkerBlobUrl: string | null = null;

const SQL_WORKER_CODE = `
  'use strict';
  let sqlite3 = null;
  let sqlite3ReadyPromise = null;
  let db = null;

  async function getOrInitSqlite() {
    if (db) return db;
    if (sqlite3ReadyPromise) return sqlite3ReadyPromise;

    sqlite3ReadyPromise = (async () => {
      const { default: sqlite3InitModule } = await import(
        ${JSON.stringify(SQLITE_WASM_URL)}
      );
      sqlite3 = await sqlite3InitModule();
      db = new sqlite3.oo1.DB(':memory:');
      return db;
    })();

    return sqlite3ReadyPromise;
  }

  // Split a SQL script into individual statements, respecting string
  // literals, comments, quoted identifiers and trigger BEGIN..END bodies.
  // Comment-only / whitespace-only chunks are dropped.
  function splitSqlStatements(code) {
    const stmts = [];
    let current = '';
    let hasCode = false;
    let beginDepth = 0;
    const n = code.length;
    let i = 0;

    const isSpace = (c) => { const k = c.charCodeAt(0); return k === 32 || k === 9 || k === 10 || k === 13; };

    while (i < n) {
      const ch = code[i];

      // -- line comment
      if (ch === '-' && code[i + 1] === '-') {
        while (i < n && code[i].charCodeAt(0) !== 10) { current += code[i]; i++; }
        continue;
      }

      // /* block comment */
      if (ch === '/' && code[i + 1] === '*') {
        current += code[i]; i++;
        current += code[i]; i++;
        while (i < n) {
          current += code[i];
          if (code[i] === '*' && code[i + 1] === '/') {
            i++;
            current += code[i];
            i++;
            break;
          }
          i++;
        }
        continue;
      }

      // 'string' / "identifier" with '' escaping — quote chars are
      // handled by char code (39 = ', 34 = ") to stay unambiguous
      // inside this template literal
      const qk = ch.charCodeAt(0);
      if (qk === 39 || qk === 34) {
        current += ch; i++;
        while (i < n) {
          const ck = code[i].charCodeAt(0);
          if (ck === qk) {
            if (i + 1 < n && code[i + 1].charCodeAt(0) === qk) {
              // Doubled quote ('' or "") — keep both, skip past both
              current += ch;
              current += code[i + 1];
              i += 2;
            } else {
              // Closing quote
              current += code[i];
              i++;
              break;
            }
          } else {
            current += code[i];
            i++;
          }
        }
        continue;
      }

      // [bracket identifier] / backtick identifier
      // (BACKTICK via charCode: a literal backtick inside this worker
      // template would terminate the string and break the file's parse)
      const BACKTICK = String.fromCharCode(96);
      if (ch === '[' || ch === BACKTICK) {
        const close = ch === '[' ? ']' : BACKTICK;
        current += ch; i++;
        while (i < n) {
          current += code[i];
          if (code[i] === close) { i++; break; }
          i++;
        }
        continue;
      }

      // word — track BEGIN / END for trigger bodies
      if (/[A-Za-z_]/.test(ch)) {
        let word = '';
        while (i < n && /[A-Za-z0-9_]/.test(code[i])) { word += code[i]; i++; }
        const upper = word.toUpperCase();
        if (upper === 'BEGIN') beginDepth++;
        else if (upper === 'END' && beginDepth > 0) beginDepth--;
        current += word;
        hasCode = true;
        continue;
      }

      // statement separator (only outside trigger bodies)
      if (ch === ';' && beginDepth === 0) {
        if (hasCode && current.trim()) stmts.push(current.trim());
        current = '';
        hasCode = false;
        i++;
        continue;
      }

      if (!isSpace(ch)) hasCode = true;
      current += ch;
      i++;
    }

    if (hasCode && current.trim()) stmts.push(current.trim());
    return stmts;
  }

  self.onmessage = async (e) => {
    const data = e.data;
    if (data.type === 'init') {
      try {
        await getOrInitSqlite();
        self.postMessage({ type: 'init_done' });
      } catch (err) {
        self.postMessage({ type: 'init_error', error: String(err && err.message || err) });
      }
      return;
    }

    if (data.type === 'execute') {
      const { id, code } = data;
      const startTime = performance.now();
      try {
        const engine = await getOrInitSqlite();

        const statements = splitSqlStatements(String(code));

        const blocks = [];
        const notices = [];
        let executed = 0;

        for (const stmtSql of statements) {
          const columnNames = [];
          const resultRows = [];
          try {
            engine.exec({
              sql: stmtSql,
              rowMode: 'array',
              columnNames,
              resultRows,
              returnValue: 'resultRows',
            });
            executed++;
            if (columnNames.length > 0) {
              blocks.push({ cols: columnNames, rows: resultRows });
            }
          } catch (stmtErr) {
            const msg = String(stmtErr && stmtErr.message || stmtErr);
            self.postMessage({
              type: 'result', id, partial: true,
              blocks, notices,
              stderr: msg,
              exitCode: 1,
              duration: performance.now() - startTime,
            });
            return;
          }
        }

        self.postMessage({
          type: 'result',
          id,
          blocks,
          notices,
          executed,
          stdout: '',
          stderr: '',
          exitCode: 0,
          duration: performance.now() - startTime,
        });
      } catch (err) {
        const duration = performance.now() - startTime;
        const stderr = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: 'result', id, stdout: '', stderr, exitCode: 1, duration });
      }
    }
  };
`;

function getOrCreateSqlWorker(): Worker {
  if (activeSqlWorker) return activeSqlWorker;

  if (!sqlWorkerBlobUrl) {
    const blob = new Blob([SQL_WORKER_CODE], { type: "application/javascript" });
    sqlWorkerBlobUrl = URL.createObjectURL(blob);
  }

  activeSqlWorker = new Worker(sqlWorkerBlobUrl, { type: "module" });
  return activeSqlWorker;
}

async function initSql(): Promise<void> {
  if (activeSqlWorker) return;
  return new Promise((resolve, reject) => {
    const worker = getOrCreateSqlWorker();
    const handleInit = (e: MessageEvent) => {
      if (e.data.type === "init_done") {
        worker.removeEventListener("message", handleInit);
        resolve();
      } else if (e.data.type === "init_error") {
        worker.removeEventListener("message", handleInit);
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener("message", handleInit);
    worker.addEventListener(
      "error",
      () => {
        worker.removeEventListener("message", handleInit);
        reject(new Error("Failed to load SQLite WASM runtime"));
      },
      { once: true }
    );
    worker.postMessage({ type: "init" });
  });
}

/** Format a result block as an ASCII table for the console */
function formatSqlTable(cols: string[], rows: unknown[][]): string {
  const cells = rows.map((row) =>
    row.map((v) => (v === null || v === undefined ? "NULL" : String(v)))
  );
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...cells.map((r) => (r[i] ?? "").length))
  );
  const line = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const fmtRow = (r: (string | null)[]) =>
    "│" + r.map((cell, i) => ` ${String(cell ?? "").padEnd(widths[i] ?? 0)} `).join("│") + "│";

  return [
    line("┌", "┬", "┐"),
    fmtRow(cols),
    line("├", "┼", "┤"),
    ...cells.map((r) => fmtRow(r)),
    line("└", "┴", "┘"),
  ].join("\n");
}

interface SqlResultMessage {
  type: string;
  id?: string;
  partial?: boolean;
  blocks?: { cols: string[]; rows: unknown[][] }[];
  notices?: string[];
  executed?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration?: number;
}

/** Execute SQL inside a dedicated, isolated Web Worker sandbox */
async function executeSql(
  code: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeout = options?.timeout ?? 30000;
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const worker = getOrCreateSqlWorker();
    const execId = Math.random().toString(36).substring(2);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // True cancellation via worker.terminate()
      if (activeSqlWorker) {
        activeSqlWorker.terminate();
        activeSqlWorker = null;
      }
      resolve({
        stdout: "",
        stderr: `⏱ SQL execution timed out after ${(timeout / 1000).toFixed(0)}s\n\nTip: You can increase the timeout in Settings, or check your queries for expensive scans.`,
        exitCode: 1,
        duration: timeout,
        timestamp: Date.now(),
      });
    }, timeout);

    const handleMessage = (e: MessageEvent) => {
      const data = e.data as SqlResultMessage;
      if (resolved || data.type !== "result" || data.id !== execId) return;
      resolved = true;
      cleanup();

      const stdoutParts: string[] = [];
      for (const block of data.blocks ?? []) {
        if (stdoutParts.length > 0) stdoutParts.push("");
        stdoutParts.push(formatSqlTable(block.cols, block.rows));
      }
      if ((data.notices?.length ?? 0) > 0) {
        stdoutParts.push(...(data.notices ?? []));
      }

      resolve({
        stdout: stdoutParts.join("\n"),
        stderr: data.stderr ?? "",
        exitCode: data.exitCode ?? 0,
        duration: data.duration ?? 0,
        timestamp: Date.now(),
      });
    };

    const handleError = (e: ErrorEvent) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        stdout: "",
        stderr: `SQL worker error: ${e.message || "Unknown error"}`,
        exitCode: 1,
        duration: 0,
        timestamp: Date.now(),
      });
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ type: "execute", id: execId, code });
  });
}

// ============================================================
// Lua 5.4 (wasmoon WASM) Web Worker Sandboxed Engine
// ============================================================
// Lua 5.4 VM compiled to WebAssembly, running in an isolated module
// worker. print() output is captured via a Lua→JS bridge function;
// errors surface to stderr. Infinite loops are cancelled via
// worker.terminate() without freezing the UI.
// ============================================================

const WASMOON_ESM_URL = "https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm";

let activeLuaWorker: Worker | null = null;
let luaWorkerBlobUrl: string | null = null;

const LUA_WORKER_CODE = `
  'use strict';
  let luaEngine = null;
  let luaReadyPromise = null;
  let luaLogs = [];

  async function getOrInitLua() {
    if (luaEngine) return luaEngine;
    if (luaReadyPromise) return luaReadyPromise;

    luaReadyPromise = (async () => {
      const { LuaFactory } = await import(${JSON.stringify(WASMOON_ESM_URL)});
      const factory = new LuaFactory();
      const engine = await factory.createEngine();
      engine.global.set('print', (...args) => {
        luaLogs.push(args.map((v) => typeof v === 'string' ? v : String(v)).join('\\t'));
      });
      return engine;
    })();

    return luaReadyPromise;
  }

  self.onmessage = async (e) => {
    const data = e.data;
    if (data.type === 'init') {
      try {
        await getOrInitLua();
        self.postMessage({ type: 'init_done' });
      } catch (err) {
        self.postMessage({ type: 'init_error', error: String(err && err.message || err) });
      }
      return;
    }

    if (data.type === 'execute') {
      const { id, code } = data;
      const startTime = performance.now();
      try {
        const engine = await getOrInitLua();
        luaLogs = [];
        await engine.doString(code);
        const duration = performance.now() - startTime;
        self.postMessage({
          type: 'result',
          id,
          stdout: luaLogs.join('\\n'),
          stderr: '',
          exitCode: 0,
          duration,
        });
      } catch (err) {
        const duration = performance.now() - startTime;
        const stderr = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: 'result', id, stdout: luaLogs.join('\\n'), stderr, exitCode: 1, duration });
      }
    }
  };
`;

function getOrCreateLuaWorker(): Worker {
  if (activeLuaWorker) return activeLuaWorker;

  if (!luaWorkerBlobUrl) {
    const blob = new Blob([LUA_WORKER_CODE], { type: "application/javascript" });
    luaWorkerBlobUrl = URL.createObjectURL(blob);
  }

  activeLuaWorker = new Worker(luaWorkerBlobUrl, { type: "module" });
  return activeLuaWorker;
}

async function initLua(): Promise<void> {
  if (activeLuaWorker) return;
  return new Promise((resolve, reject) => {
    const worker = getOrCreateLuaWorker();
    const handleInit = (e: MessageEvent) => {
      if (e.data.type === "init_done") {
        worker.removeEventListener("message", handleInit);
        resolve();
      } else if (e.data.type === "init_error") {
        worker.removeEventListener("message", handleInit);
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener("message", handleInit);
    worker.addEventListener(
      "error",
      () => {
        worker.removeEventListener("message", handleInit);
        reject(new Error("Failed to load Lua WASM runtime"));
      },
      { once: true }
    );
    worker.postMessage({ type: "init" });
  });
}

/** Execute Lua inside a dedicated, isolated Web Worker sandbox */
async function executeLua(
  code: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeout = options?.timeout ?? 30000;
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const worker = getOrCreateLuaWorker();
    const execId = Math.random().toString(36).substring(2);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // True infinite-loop cancellation via worker.terminate()
      if (activeLuaWorker) {
        activeLuaWorker.terminate();
        activeLuaWorker = null;
      }
      resolve({
        stdout: "",
        stderr: `⏱ Lua execution timed out after ${(timeout / 1000).toFixed(0)}s\n\nTip: You can increase the timeout in Settings, or check your code for infinite loops.`,
        exitCode: 1,
        duration: timeout,
        timestamp: Date.now(),
      });
    }, timeout);

    const handleMessage = (e: MessageEvent) => {
      if (resolved) return;
      const data = e.data;
      if (data.type !== "result" || data.id !== execId) return;
      resolved = true;
      cleanup();
      resolve({
        stdout: data.stdout || "",
        stderr: data.stderr || "",
        exitCode: data.exitCode ?? 0,
        duration: data.duration ?? 0,
        timestamp: Date.now(),
      });
    };

    const handleError = (e: ErrorEvent) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        stdout: "",
        stderr: `Lua worker error: ${e.message || "Unknown error"}`,
        exitCode: 1,
        duration: 0,
        timestamp: Date.now(),
      });
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ type: "execute", id: execId, code });
  });
}

// ============================================================
// CompilerService Implementation
// ============================================================
export class BrowserCompilerService implements ICompilerService {
  async execute(
    code: string,
    language: Language,
    options?: ExecutionOptions
  ): Promise<ExecutionResult> {
    switch (language) {
      case "javascript":
        return executeJavaScript(code, options);
      case "typescript":
        return executeTypeScript(code, options);
      case "python":
        return executePython(code, options);
      case "sql":
        return executeSql(code, options);
      case "lua":
        return executeLua(code, options);
      case "html":
        // HTML is previewed, not executed — return a success stub
        return {
          stdout: "HTML preview rendered successfully.",
          stderr: "",
          exitCode: 0,
          duration: 0,
          timestamp: Date.now(),
        };
      default:
        return {
          stdout: "",
          stderr: `Unsupported language: ${language}`,
          exitCode: 1,
          duration: 0,
          timestamp: Date.now(),
        };
    }
  }

  async cancel(): Promise<void> {
    let cancelled = false;
    if (cancelWorkerExecution()) {
      cancelled = true;
    }
    if (activePythonWorker) {
      activePythonWorker.terminate();
      activePythonWorker = null;
      isPythonReady = false;
      cancelled = true;
    }
    if (activeSqlWorker) {
      activeSqlWorker.terminate();
      activeSqlWorker = null;
      cancelled = true;
    }
    if (activeLuaWorker) {
      activeLuaWorker.terminate();
      activeLuaWorker = null;
      cancelled = true;
    }
    if (!cancelled) {
      // No active worker was running
    }
  }

  async isReady(language: Language): Promise<boolean> {
    if (language === "python") {
      return isPythonReady;
    }
    if (language === "typescript") {
      return tsModule !== null;
    }
    if (language === "sql") {
      return activeSqlWorker !== null;
    }
    if (language === "lua") {
      return activeLuaWorker !== null;
    }
    return true;
  }

  async initialize(language: Language): Promise<void> {
    if (language === "python") {
      await initPython();
    }
    if (language === "typescript") {
      await loadTypeScriptCompiler();
    }
    if (language === "sql") {
      await initSql();
    }
    if (language === "lua") {
      await initLua();
    }
  }
}

/** Singleton compiler service */
export const compilerService = new BrowserCompilerService();

