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
// TypeScript Compiler (vendored — bundled at build time)
// ============================================================
// The compiler is imported from the installed `typescript` package
// so transpilation works fully OFFLINE. Vite code-splits it into a
// lazy chunk that downloads on first TS run instead of a CDN fetch.
type TSModule = typeof import("typescript");
let tsModule: TSModule | null = null;
let tsLoadPromise: Promise<TSModule> | null = null;

async function loadTypeScriptCompiler(): Promise<TSModule> {
  if (tsModule) return tsModule;
  if (tsLoadPromise) return tsLoadPromise;

  tsLoadPromise = import("typescript")
    .then((mod) => {
      tsModule = (mod.default ?? mod) as TSModule;
      return tsModule;
    })
    .catch((err) => {
      tsLoadPromise = null;
      throw new Error(
        `Failed to load the bundled TypeScript compiler: ${err instanceof Error ? err.message : String(err)}`
      );
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
/**
 * Execute JavaScript code inside a Web Worker sandbox.
 * - No access to DOM, window, document, localStorage
 * - Configurable timeout with automatic termination
 * - Cancellable via cancelWorkerExecution()
 * - Streams console output line-by-line via onStdout/onStderr
 */
function executeInWorker(
  code: string,
  timeout: number = 10000,
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
  stdin?: string
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    // Build the worker script
    const workerScript = `
      'use strict';

      // ── Console capture ──────────────────────────────
      const __stdout = [];
      const __stderr = [];

      // Stream a completed line to the main thread as soon as it's
      // produced, so long-running programs show output live.
      function __stream(kind, text) {
        if (!text) return;
        __safePostMessage({ type: 'stream', kind, text });
      }

      function __emitLine(kind, line) {
        if (kind === 'stdout') __stdout.push(line);
        else __stderr.push(line);
        __stream(kind, line);
      }

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

      // Shared timer map so console.timeEnd can see timers registered
      // by console.time (declared outside the object literal).
      const __timers = {};

      const console = {
        log: (...args) => {
          __emitLine('stdout', args.map(__formatArg).join(' '));
        },
        info: (...args) => {
          __emitLine('stdout', args.map(__formatArg).join(' '));
        },
        warn: (...args) => {
          __emitLine('stderr', '[warn] ' + args.map(__formatArg).join(' '));
        },
        error: (...args) => {
          __emitLine('stderr', args.map(__formatArg).join(' '));
        },
        debug: (...args) => {
          __emitLine('stdout', '[debug] ' + args.map(__formatArg).join(' '));
        },
        table: (data) => {
          __emitLine('stdout', JSON.stringify(data, null, 2));
        },
        clear: () => {
          __stdout.length = 0;
          __stderr.length = 0;
        },
        dir: (obj) => {
          __emitLine('stdout', JSON.stringify(obj, null, 2));
        },
        // time/timeEnd share the __timers map declared above.
        time: (label = 'default') => { __timers[label] = performance.now(); },
        timeEnd: (label = 'default') => {
          const start = __timers[label];
          if (start !== undefined) {
            __emitLine('stdout', label + ': ' + (performance.now() - start).toFixed(3) + 'ms');
            delete __timers[label];
          }
        },
        assert: (condition, ...args) => {
          if (!condition) {
            __emitLine('stderr', 'Assertion failed: ' + args.map(__formatArg).join(' '));
          }
        },
        count: (() => {
          const counts = {};
          return (label = 'default') => {
            counts[label] = (counts[label] || 0) + 1;
            __emitLine('stdout', label + ': ' + counts[label]);
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

      // ── Stdin ────────────────────────────────────────
      const __stdinLines = ${JSON.stringify(stdin ?? "")}.length
        ? ${JSON.stringify(stdin ?? "")}.split('\\n')
        : [];
      let __stdinPos = 0;
      function __nextLine() {
        return __stdinPos < __stdinLines.length ? __stdinLines[__stdinPos++] : null;
      }
      // Simple sync readline: returns the next stdin line (null at EOF).
      // prompt('Your name: ') echoes the prompt and reads a line.
      function readline() { return __nextLine(); }
      function prompt(msg) {
        if (msg !== undefined && msg !== null && msg !== '') __stream('stdout', String(msg));
        return __nextLine();
      }

      // ── Execute ──────────────────────────────────────
      const __startTime = performance.now();

      try {
        // Wrap in an async IIFE so top-level await works
        const __asyncFn = new Function(
          'console', 'fetch', 'readline', 'prompt',
          '"use strict"; return (async () => {\\n' + ${JSON.stringify(code)} + '\\n})();'
        );
        __asyncFn(console, fetch, readline, prompt).then(() => {
          const __duration = performance.now() - __startTime;
          __safePostMessage({
            type: 'result',
            stdout: __stdout.join('\\n'),
            stderr: __stderr.length > 0
              ? __stderr.join('\\n')
              : '',
            exitCode: 0,
            duration: __duration,
          });
        }).catch((err) => {
          const __duration = performance.now() - __startTime;
          const errorMsg = err instanceof Error
            ? err.name + ': ' + err.message
            : String(err);
          __safePostMessage({
            type: 'result',
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
          type: 'result',
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

    // Streaming + result handler
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data;
      if (data?.type === "stream") {
        if (data.kind === "stderr") onStderr?.(data.text);
        else onStdout?.(data.text);
        return;
      }
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      worker.terminate();
      activeWorker = null;
      URL.revokeObjectURL(blobUrl);

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
  try {
    const bundled = await bundleTabModules(code, options?.moduleSources ?? {});
    return await executeInWorker(bundled, timeout, options?.onStdout, options?.onStderr, options?.stdin);
  } catch (error) {
    return {
      stdout: "",
      stderr: `Module bundling failed: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      duration: 0,
      timestamp: Date.now(),
    };
  }
}

/** Execute TypeScript: real compilation → Web Worker */
async function executeTypeScript(
  code: string,
  options?: ExecutionOptions
): Promise<ExecutionResult> {
  const timeout = options?.timeout ?? 10000;

  try {
    // Transpile TS → JS using the real TypeScript compiler.
    // Sibling tab sources are passed through the entry as ESM specifiers
    // so the bundler resolves them after transpilation.
    const { js, diagnostics } = await transpileTypeScript(code);

    // Report any compilation warnings/errors but still execute
    let warnings = "";
    if (diagnostics.length > 0) {
      warnings = diagnostics.map((d) => `[TS] ${d}`).join("\n");
    }

    const bundled = await bundleTabModules(js, options?.moduleSources ?? {});
    const result = await executeInWorker(bundled, timeout, options?.onStdout, options?.onStderr, options?.stdin);

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
// Multi-file tab programs — CJS-style bundling of sibling tabs
// ============================================================
// `import x from "./utils.ts"` inside a JS/TS tab is resolved from
// the other open tabs (moduleSources) and bundled into one sandbox-
// safe script. Circular imports are detected and reported.

function normalizeTabSpecifier(spec: string): string {
  return spec.replace(/^\.\//, "").replace(/^\.\./, "");
}

function resolveTabModule(
  spec: string,
  moduleSources: Record<string, string>
): string | null {
  const clean = normalizeTabSpecifier(spec);
  const names = Object.keys(moduleSources);
  return (
    names.find((n) => n === clean) ??
    names.find((n) => n.toLowerCase() === clean.toLowerCase()) ??
    names.find((n) => n.replace(/\.[^.]+$/, "") === clean.replace(/\.[^.]+$/, "")) ??
    null
  );
}

/** Strip comments (respecting strings) so import scanning is accurate */
function stripCodeComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Extract ESM import specifiers + default/namespace hints from a transpiled module */
function scanEsmImports(js: string): string[] {
  const clean = stripCodeComments(js);
  const specs: string[] = [];
  const re = /import\s*[\s\S]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|export\s*\*\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Bundle an entry script with sibling tab modules into a single CJS-style
 * script. Unresolvable specifiers are left untouched (real ESM/fail at runtime).
 */
async function bundleTabModules(
  entryJs: string,
  moduleSources: Record<string, string>
): Promise<string> {
  if (Object.keys(moduleSources).length === 0) return entryJs;

  const modules = new Map<string, string>(); // tabName → CJS factory body
  const visiting = new Set<string>();

  async function compileToCjs(spec: string, rawSource: string): Promise<void> {
    if (modules.has(spec)) return;
    if (visiting.has(spec)) {
      throw new Error(`Circular import detected: "${[...visiting, spec].join(" → ")}"`);
    }
    visiting.add(spec);
    if (visiting.size > 64) {
      throw new Error(`Module graph too deep while bundling "${spec}"`);
    }

    let js: string;
    if (/\.(ts|tsx)$/i.test(spec)) {
      const t = tsModule ?? (await loadTypeScriptCompiler());
      js = t.transpileModule(rawSource, {
        compilerOptions: {
          target: t.ScriptTarget.ES2022,
          module: t.ModuleKind.CommonJS,
          strict: true,
          esModuleInterop: true,
          allowJs: true,
          sourceMap: false,
        },
      }).outputText;
    } else {
      // JS tabs keep ESM syntax until imported — transpile to CJS via TS
      // (allowJs) so `export` becomes exports assignments too.
      const t = tsModule ?? (await loadTypeScriptCompiler());
      js = t.transpileModule(rawSource, {
        compilerOptions: {
          target: t.ScriptTarget.ES2022,
          module: t.ModuleKind.CommonJS,
          esModuleInterop: true,
          allowJs: true,
          sourceMap: false,
        },
      }).outputText;
    }

    // Recurse into that module's own tab imports first
    for (const inner of scanEsmImports(js)) {
      const resolved = resolveTabModule(inner, moduleSources);
      if (resolved) await compileToCjs(resolved, moduleSources[resolved]!);
    }

    // Rewrite resolved tab imports to runtime __require calls
    const body = js.replace(
      /(\bimport\s[\s\S]*?from\s*|\bimport\s*|\bexport\s\*\s*from\s*)(["'])([^"']+)(\2)/g,
      (full, head: string, q: string, spec2: string) => {
        const resolved = resolveTabModule(spec2, moduleSources);
        return resolved ? `__require(${JSON.stringify(resolved)})` : full;
      }
    );

    modules.set(spec, body);
    visiting.delete(spec);
  }

  // Entry is already-transpiled JS from the caller (TS path) or raw JS.
  // Compile dependencies first, then rewrite the entry's own imports to
  // destructure the module's exports so bindings keep working:
  //   import greet, { PI } from "./utils.ts"  →
  //   var __m0 = __require("utils.ts"); var greet = __m0.default ?? __m0; var PI = __m0.PI;
  const entryImports = scanEsmImports(entryJs)
    .map((s) => resolveTabModule(s, moduleSources))
    .filter((s): s is string => Boolean(s));

  for (const spec of new Set(entryImports)) {
    await compileToCjs(spec, moduleSources[spec]!);
  }
  if (modules.size === 0) return entryJs;

  let entry = entryJs;
  let modIdx = 0;
  entry = entry.replace(
    /\bimport\s+([\w$]+)\s*,?\s*(?:\{([^}]*)\})?\s*from\s*(["'])([^"']+)(\3)/g,
    (full, defaultBind: string | undefined, named: string | undefined, _q: string, spec: string) => {
      const resolved = resolveTabModule(spec, moduleSources);
      if (!resolved) return full;
      const v = `__m${modIdx++}`;
      let out = `var ${v} = __require(${JSON.stringify(resolved)});`;
      if (defaultBind) out += ` var ${defaultBind} = ${v}.default !== undefined ? ${v}.default : ${v};`;
      if (named) {
        for (const part of named.split(",")) {
          const clause = part.trim();
          if (!clause) continue;
          const alias = clause.split(/\s+as\s+/);
          const imported = alias[0]!.trim();
          const local = (alias[1] ?? imported).trim();
          out += ` var ${local} = ${v}[${JSON.stringify(imported)}];`;
        }
      }
      return out;
    }
  );
  // Named-only imports: import { a, b as c } from "..."
  entry = entry.replace(
    /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)(\2)/g,
    (full, named: string, _q: string, spec: string) => {
      const resolved = resolveTabModule(spec, moduleSources);
      if (!resolved) return full;
      const v = `__m${modIdx++}`;
      let out = `var ${v} = __require(${JSON.stringify(resolved)});`;
      for (const part of named.split(",")) {
        const clause = part.trim();
        if (!clause) continue;
        const alias = clause.split(/\s+as\s+/);
        const imported = alias[0]!.trim();
        const local = (alias[1] ?? imported).trim();
        out += ` var ${local} = ${v}[${JSON.stringify(imported)}];`;
      }
      return out;
    }
  );
  // Namespace imports: import * as ns from "..."
  entry = entry.replace(
    /\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(["'])([^"']+)(\2)/g,
    (full, ns: string, _q: string, spec: string) => {
      const resolved = resolveTabModule(spec, moduleSources);
      return resolved ? `var ${ns} = __require(${JSON.stringify(resolved)});` : full;
    }
  );
  // Side-effect imports: import "./thing.ts"
  entry = entry.replace(
    /\bimport\s*(["'])([^"']+)(\1)/g,
    (full, _q: string, spec: string) => {
      const resolved = resolveTabModule(spec, moduleSources);
      return resolved ? `__require(${JSON.stringify(resolved)});` : full;
    }
  );

  const moduleEntries = [...modules.entries()]
    .map(([name, body]) => `${JSON.stringify(name)}: function(exports, require, module) {\n${body}\n},`)
    .join("\n");

  // NOTE: executeInWorker wraps this code in `return (async () => { … })()`
  // — so the final `return (async function(){…})()` hands the program's
  // promise back to the wrapper, giving proper completion + error capture.
  return `
var __modules = {
${moduleEntries}
};
var __cache = {};
function __require(name) {
  if (__cache[name]) return __cache[name].exports;
  if (!__modules[name]) throw new Error("Cannot find module '" + name + "'");
  var module = { exports: {} };
  __cache[name] = module;
  try {
    __modules[name].call(module.exports, module.exports, __require, module);
  } catch (err) {
    delete __cache[name];
    throw err;
  }
  return module.exports;
}
return (async function() {
${entry}
})();
`;
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
      const { id, code, stdin } = data;
      const startTime = performance.now();
      try {
        const engine = await getOrInitPyodide();

        // Stream stdout to the UI as it is printed (line-buffered),
        // while still accumulating the full text for the final result.
        let __streamBuf = '';
        engine.setStdout({
          batched: (text) => {
            __streamBuf += text;
            self.postMessage({ type: 'stream', id, kind: 'stdout', text });
          }
        });
        engine.setStderr({
          batched: (text) => {
            self.postMessage({ type: 'stream', id, kind: 'stderr', text });
          }
        });

        // Provide stdin: input() / sys.stdin read from the provided text.
        // Each input() consumes one line; EOF raises EOFError like a real
        // terminal when the stdin box runs dry.
        const stdinText = stdin || '';
        const __NL = String.fromCharCode(10);
        // Build a safe Python single-quoted string literal.
        // NOTE: this code lives inside a template literal, so backslash
        // escapes here would be consumed by the outer template — use
        // String.fromCharCode to stay escape-free.
        const __BS = String.fromCharCode(92);
        const pyStdinLiteral = "'" + stdinText
          .split(__BS).join(__BS + __BS)
          .split("'").join(__BS + "'")
          .split(__NL).join(__BS + 'n')
          .split(String.fromCharCode(13)).join(__BS + 'r') + "'";
        const setupCode = [
          'import sys, io',
          'class _TabStdin(io.StringIO):',
          '    def readline(self, size=-1):',
          '        line = super().readline(size)',
          "        if line == '' and size != 0:",
          "            raise EOFError('EOF when reading a line (no more stdin provided)')",
          '        return line',
          'sys.stdin = _TabStdin(' + pyStdinLiteral + ')'
        ].join(__NL);
        engine.runPython(setupCode);

        try {
          await engine.runPythonAsync(code);
        } catch (runErr) {
          const stderr = runErr instanceof Error ? runErr.message : String(runErr);
          const duration = performance.now() - startTime;
          self.postMessage({ type: 'result', id, stdout: __streamBuf.trimEnd(), stderr, exitCode: 1, duration });
          return;
        }

        const duration = performance.now() - startTime;
        self.postMessage({
          type: 'result',
          id,
          stdout: __streamBuf.trimEnd(),
          stderr: '',
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
        // The runtime failed to load — terminate the broken worker so the
        // next attempt builds a fresh one instead of reusing the cached
        // rejected ready-promise inside it.
        worker.terminate();
        if (activePythonWorker === worker) {
          activePythonWorker = null;
          pythonWorkerBlobUrl = null;
          isPythonReady = false;
        }
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
      const data = e.data;
      if (data?.type === "stream" && data.id === execId) {
        if (data.kind === "stderr") options?.onStderr?.(data.text);
        else options?.onStdout?.(data.text);
        return;
      }
      if (resolved) return;
      if (data?.type === "result" && data.id === execId) {
        resolved = true;
        cleanup();
        resolve({
          stdout: data.stdout || "",
          stderr: data.stderr || "",
          exitCode: data.exitCode ?? 0,
          duration: data.duration ?? 0,
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
    worker.postMessage({ type: "execute", id: execId, code, stdin: options?.stdin ?? "" });
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
        // Runtime failed to load — drop the broken worker so the next
        // attempt builds a fresh one (the worker caches its rejected
        // ready-promise, so retrying inside it would never succeed).
        worker.terminate();
        if (activeSqlWorker === worker) {
          activeSqlWorker = null;
          sqlWorkerBlobUrl = null;
        }
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
        // Runtime failed to load — drop the broken worker so the next
        // attempt builds a fresh one (the worker caches its rejected
        // ready-promise, so retrying inside it would never succeed).
        worker.terminate();
        if (activeLuaWorker === worker) {
          activeLuaWorker = null;
          luaWorkerBlobUrl = null;
        }
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

