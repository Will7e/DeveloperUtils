// ============================================================
// Compiler Service — Browser-based code execution
// ============================================================
// This service uses browser-native engines (eval, Pyodide WASM).
// The ICompilerService interface allows swapping to a backend
// execution service in the future with zero UI changes.
// ============================================================

import type { Language, ExecutionResult, ICompilerService } from "@/types";

/** Capture console output by intercepting console methods */
function createOutputCapture() {
  let stdout = "";
  let stderr = "";

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };

  function start() {
    stdout = "";
    stderr = "";

    console.log = (...args: unknown[]) => {
      stdout += args.map(formatArg).join(" ") + "\n";
    };
    console.info = (...args: unknown[]) => {
      stdout += args.map(formatArg).join(" ") + "\n";
    };
    console.warn = (...args: unknown[]) => {
      stderr += "[warn] " + args.map(formatArg).join(" ") + "\n";
    };
    console.error = (...args: unknown[]) => {
      stderr += args.map(formatArg).join(" ") + "\n";
    };
  }

  function stop() {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
  }

  function getOutput() {
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
  }

  return { start, stop, getOutput };
}

/** Format any value for console output */
function formatArg(arg: unknown): string {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "string") return arg;
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/** Execute JavaScript code in a sandboxed context */
async function executeJavaScript(code: string): Promise<ExecutionResult> {
  const capture = createOutputCapture();
  const startTime = performance.now();

  capture.start();
  let exitCode = 0;

  try {
    // Create a sandboxed function to avoid polluting global scope
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(code);
    await fn();
  } catch (error) {
    exitCode = 1;
    const errorMsg =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    capture.stop();
    const duration = performance.now() - startTime;
    const { stdout, stderr } = capture.getOutput();
    return {
      stdout,
      stderr: stderr ? `${stderr}\n${errorMsg}` : errorMsg,
      exitCode,
      duration,
      timestamp: Date.now(),
    };
  }

  capture.stop();
  const duration = performance.now() - startTime;
  const { stdout, stderr } = capture.getOutput();

  return { stdout, stderr, exitCode, duration, timestamp: Date.now() };
}

/** Execute TypeScript by stripping types and running as JS */
async function executeTypeScript(code: string): Promise<ExecutionResult> {
  // Strip TypeScript type annotations for browser execution
  // This is a simplified approach — a full TS compiler could be loaded via WASM
  let jsCode = code;

  // Remove interface/type declarations
  jsCode = jsCode.replace(
    /^(export\s+)?(interface|type)\s+\w+[\s\S]*?^\}/gm,
    ""
  );
  // Remove type annotations from function parameters and return types
  jsCode = jsCode.replace(/:\s*\w+(\[\])?(\s*[,\)\{=])/g, "$2");
  // Remove generic type parameters
  jsCode = jsCode.replace(/<\w+(\s*,\s*\w+)*>/g, "");
  // Remove 'as' type assertions
  jsCode = jsCode.replace(/\s+as\s+\w+/g, "");
  // Remove access modifiers
  jsCode = jsCode.replace(/\b(public|private|protected|readonly)\s+/g, "");

  return executeJavaScript(jsCode);
}

// ============================================================
// Pyodide (Python WASM) Engine
// ============================================================
let pyodideInstance: any = null;
let pyodideLoading = false;
let pyodideLoadPromise: Promise<any> | null = null;

async function loadPyodide(): Promise<any> {
  if (pyodideInstance) return pyodideInstance;

  if (pyodideLoadPromise) return pyodideLoadPromise;

  pyodideLoading = true;
  pyodideLoadPromise = new Promise(async (resolve, reject) => {
    try {
      // Load Pyodide from CDN
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js";
      script.async = true;

      script.onload = async () => {
        try {
          // @ts-expect-error - Pyodide is loaded globally
          const pyodide = await window.loadPyodide({
            indexURL:
              "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/",
          });
          pyodideInstance = pyodide;
          pyodideLoading = false;
          resolve(pyodide);
        } catch (err) {
          pyodideLoading = false;
          reject(err);
        }
      };

      script.onerror = () => {
        pyodideLoading = false;
        reject(new Error("Failed to load Pyodide"));
      };

      document.head.appendChild(script);
    } catch (err) {
      pyodideLoading = false;
      reject(err);
    }
  });

  return pyodideLoadPromise;
}

async function executePython(code: string): Promise<ExecutionResult> {
  const startTime = performance.now();

  try {
    const pyodide = await loadPyodide();

    // Capture Python stdout/stderr
    pyodide.runPython(`
import sys
from io import StringIO
sys.stdout = StringIO()
sys.stderr = StringIO()
`);

    try {
      await pyodide.runPythonAsync(code);
    } catch (err: any) {
      const stdout = pyodide.runPython("sys.stdout.getvalue()");
      const stderr = err.message || String(err);
      const duration = performance.now() - startTime;

      // Reset stdout/stderr
      pyodide.runPython(`
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
`);

      return {
        stdout: stdout || "",
        stderr,
        exitCode: 1,
        duration,
        timestamp: Date.now(),
      };
    }

    const stdout = pyodide.runPython("sys.stdout.getvalue()");
    const stderr = pyodide.runPython("sys.stderr.getvalue()");
    const duration = performance.now() - startTime;

    // Reset stdout/stderr
    pyodide.runPython(`
sys.stdout = sys.__stdout__
sys.stderr = sys.__stderr__
`);

    return {
      stdout: (stdout || "").trimEnd(),
      stderr: (stderr || "").trimEnd(),
      exitCode: 0,
      duration,
      timestamp: Date.now(),
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    return {
      stdout: "",
      stderr:
        error instanceof Error ? error.message : "Failed to initialize Python",
      exitCode: 1,
      duration,
      timestamp: Date.now(),
    };
  }
}

// ============================================================
// CompilerService Implementation
// ============================================================
export class BrowserCompilerService implements ICompilerService {
  async execute(code: string, language: Language): Promise<ExecutionResult> {
    switch (language) {
      case "javascript":
        return executeJavaScript(code);
      case "typescript":
        return executeTypeScript(code);
      case "python":
        return executePython(code);
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

  async isReady(language: Language): Promise<boolean> {
    if (language === "python") {
      return pyodideInstance !== null;
    }
    return true;
  }

  async initialize(language: Language): Promise<void> {
    if (language === "python") {
      await loadPyodide();
    }
  }
}

/** Singleton compiler service */
export const compilerService = new BrowserCompilerService();
