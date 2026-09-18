// ============================================================
// Compiler Service — Production-grade browser-based execution
// ============================================================
// Execution strategy:
//   • JavaScript  → Web Worker sandbox (isolated, with timeout)
//   • TypeScript  → Real TS compiler (CDN) → Web Worker sandbox
//   • Python      → Pyodide WASM (in-page, with timeout wrapper)
//   • HTML        → Preview stub (rendered in iframe elsewhere)
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
        reject(new Error("Failed to load TypeScript compiler from CDN"));
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
    return true;
  }

  async initialize(language: Language): Promise<void> {
    if (language === "python") {
      await initPython();
    }
    if (language === "typescript") {
      await loadTypeScriptCompiler();
    }
  }
}

/** Singleton compiler service */
export const compilerService = new BrowserCompilerService();

