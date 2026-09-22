// ============================================================
// Type Check Worker — The Actual Compiler Run
// ============================================================
// TypeScript is large and synchronous, so it runs here rather than on the
// page: a type check must not freeze the chat while a stream is arriving.
//
// Three things are loaded lazily, at most once per worker:
//   • the compiler itself, from the same module host the preview uses;
//   • TypeScript's OWN lib .d.ts files (lib.es2020.d.ts, lib.dom.d.ts and
//     their transitive references), because without them every `Promise`
//     and `console` in the workspace is an error and the report becomes
//     noise;
//   • nothing else — there is no node_modules to load, which is why the
//     page supplies the ambient shims that erase third-party imports.
//
// The lib set is discovered from the package manifest rather than
// hardcoded, so the lib files always match the compiler version exactly.
// A hardcoded list is kept as a fallback for when that lookup fails; it is
// deliberately narrow, and the report says when the fallback was used.
//
// Protocol: one request per message, one response per request. The worker
// keeps no state between requests, so a stale check can never answer a
// later question.

import type { RawDiagnostic } from "./typecheck";

interface TypecheckRequest {
  kind: "typecheck";
  id: number;
  version: string;
  /** path → content, rooted at "/" (see the client) */
  files: Record<string, string>;
  rootNames: string[];
  compilerOptions: Record<string, unknown>;
}

interface TypecheckResponse {
  kind: "typecheck-result";
  id: number;
  ok: boolean;
  diagnostics: RawDiagnostic[];
  /** Non-fatal notes: lib fallback used, timing, etc. */
  notes: string[];
  error?: string;
}

const MODULE_HOST = "https://esm.sh";
const LIB_HOST = "https://cdn.jsdelivr.net/npm/typescript";

/** Minimal lib set used only when the package manifest cannot be read */
const FALLBACK_LIB_FILES = [
  "lib.es5.d.ts",
  "lib.es2015.d.ts",
  "lib.es2016.d.ts",
  "lib.es2017.d.ts",
  "lib.es2018.d.ts",
  "lib.es2019.d.ts",
  "lib.es2020.d.ts",
  "lib.es2021.d.ts",
  "lib.es2022.d.ts",
  "lib.es2023.d.ts",
  "lib.es2024.d.ts",
  "lib.dom.d.ts",
  "lib.dom.iterable.d.ts",
  "lib.es2015.iterable.d.ts",
  "lib.es2015.symbol.wellknown.d.ts",
  "lib.decorators.d.ts",
  "lib.decorators.legacy.d.ts",
];

/** The compiler module, once loaded */
let tsModule: TypeScriptApi | null = null;
/** lib file name → text, once fetched */
let libFiles: Map<string, string> | null = null;
let libNotes: string[] = [];

/**
 * Only the slice of the TypeScript API this worker touches. Typing it
 * locally keeps `import("https://…")` (which has no types) honest instead
 * of casting the whole module to `any` and losing every check below.
 */
interface TypeScriptApi {
  createSourceFile: (
    fileName: string,
    text: string,
    languageVersion: unknown,
    setParentNodes?: boolean
  ) => unknown;
  createCompilerHost: (options: Record<string, unknown>) => CompilerHost;
  createProgram: (rootNames: string[], options: Record<string, unknown>, host: CompilerHost) => Program;
  getPreEmitDiagnostics: (program: Program) => TsDiagnostic[];
  flattenDiagnosticMessageText: (text: unknown, newLine: string) => string;
  ScriptTarget: { Latest: unknown };
  DiagnosticCategory: { Error: number; Warning: number };
}

interface CompilerHost {
  getSourceFile: (fileName: string, languageVersion: unknown) => unknown;
  getDefaultLibFileName: (options: Record<string, unknown>) => string;
  writeFile: () => void;
  getCurrentDirectory: () => string;
  getCanonicalFileName: (fileName: string) => string;
  useCaseSensitiveFileNames: () => boolean;
  getNewLine: () => string;
  fileExists: (fileName: string) => boolean;
  readFile: (fileName: string) => string | undefined;
  getDirectories?: (path: string) => string[];
}

interface Program {
  getSourceFiles: () => Array<{ fileName: string }>;
  getSyntacticDiagnostics: () => TsDiagnostic[];
}

interface TsDiagnostic {
  file?: { fileName: string };
  start?: number;
  code: number;
  category: number;
  messageText: unknown;
}

/** Loads the compiler from the module host, once */
async function ensureCompiler(version: string): Promise<TypeScriptApi> {
  if (tsModule) return tsModule;
  const url = `${MODULE_HOST}/typescript@${version}?target=es2022`;
  // @vite-ignore: the URL is resolved at runtime, not by the bundler.
  const mod = (await import(/* @vite-ignore */ url)) as { default?: TypeScriptApi } & TypeScriptApi;
  tsModule = (mod.default ?? mod) as TypeScriptApi;
  if (typeof tsModule.createProgram !== "function") {
    tsModule = null;
    throw new Error("the compiler module loaded but does not expose createProgram");
  }
  return tsModule;
}

/** Every lib .d.ts the compiler ships, discovered from its own manifest */
async function libManifest(version: string): Promise<string[]> {
  const url = `https://data.jsdelivr.com/v1/packages/npm/typescript@${version}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`manifest lookup failed (${response.status})`);
  const payload = (await response.json()) as {
    files?: Array<{ name?: string; type?: string; files?: Array<{ name?: string; type?: string }> }>;
  };
  const libDir = payload.files?.find((f) => f.name === "lib" && typeof f.files !== "undefined");
  const names = (libDir?.files ?? [])
    .filter((f) => f.type === "file" && typeof f.name === "string")
    .map((f) => f.name as string)
    .filter((name) => /^lib\..*\.d\.ts$/.test(name));
  if (names.length === 0) throw new Error("the manifest listed no lib files");
  return names;
}

/**
 * Loads TypeScript's lib .d.ts files.
 *
 * These are fetched as TEXT (never executed), so they are data, not code:
 * a CDN cannot inject into the worker through them.
 */
async function ensureLibs(version: string): Promise<Map<string, string>> {
  if (libFiles) return libFiles;

  let names: string[];
  try {
    names = await libManifest(version);
  } catch (err) {
    names = FALLBACK_LIB_FILES;
    libNotes.push(
      `used a built-in subset of TypeScript's lib files (could not read the package manifest: ${
        err instanceof Error ? err.message : "unknown error"
      })`
    );
  }

  const loaded = new Map<string, string>();
  const fetched = await Promise.all(
    names.map(async (name) => {
      try {
        const response = await fetch(`${LIB_HOST}@${version}/lib/${name}`);
        if (!response.ok) return null;
        return [name, await response.text()] as const;
      } catch {
        return null;
      }
    })
  );
  for (const entry of fetched) {
    if (entry) loaded.set(`/${entry[0]}`, entry[1]);
  }
  if (loaded.size === 0) {
    throw new Error("none of TypeScript's lib files could be loaded");
  }
  if (loaded.size < names.length) {
    libNotes.push(
      `loaded ${loaded.size} of ${names.length} lib files; the missing ones are reported as unavailable rather than as errors in your code`
    );
  }
  libFiles = loaded;
  return loaded;
}

/** Maps a position to a 1-based line number */
function lineOf(source: { text: string; lineMap?: readonly number[] } | undefined, start: number | undefined): number | null {
  if (!source || typeof start !== "number") return null;
  let line = 1;
  for (let i = 0; i < start && i < source.text.length; i++) {
    if (source.text.charCodeAt(i) === 10) line++;
  }
  return line;
}

async function typecheck(request: TypecheckRequest): Promise<TypecheckResponse> {
  const started = Date.now();
  try {
    const ts = await ensureCompiler(request.version);
    const libs = await ensureLibs(request.version);

    const files = new Map(Object.entries(request.files));
    const host = ts.createCompilerHost(request.compilerOptions);
    const sourceCache = new Map<string, { text: string; lineMap?: readonly number[] }>();

    // The default lib lives at the root of the virtual FS, which is where
    // TypeScript looks for the `lib.*.d.ts` files it needs.
    const defaultLib = "/lib.dom.d.ts";

    host.getSourceFile = (fileName: string, languageVersion: unknown) => {
      const normalized = normalizeFileName(fileName);
      const text = files.get(normalized) ?? libs.get(normalized);
      if (text === undefined) return undefined;
      const source = ts.createSourceFile(normalized, text, languageVersion, true) as {
        text: string;
      };
      sourceCache.set(normalized, source);
      return source;
    };
    host.getDefaultLibFileName = () => defaultLib;
    host.fileExists = (fileName: string) =>
      files.has(normalizeFileName(fileName)) || libs.has(normalizeFileName(fileName));
    host.readFile = (fileName: string) =>
      files.get(normalizeFileName(fileName)) ?? libs.get(normalizeFileName(fileName));
    host.writeFile = () => {};
    host.getCurrentDirectory = () => "/";
    host.getDirectories = () => [];
    host.getCanonicalFileName = (fileName: string) => fileName;
    host.useCaseSensitiveFileNames = () => true;
    host.getNewLine = () => "\n";

    const program = ts.createProgram(request.rootNames, request.compilerOptions, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const fileName = diagnostic.file?.fileName ?? null;
      const normalized = fileName ? normalizeFileName(fileName) : null;
      return {
        file: normalized && !libs.has(normalized) ? normalized.replace(/^\//, "") : null,
        line: diagnostic.file ? lineOf(sourceCache.get(normalized ?? ""), diagnostic.start) : null,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        category: diagnostic.category === ts.DiagnosticCategory.Warning ? 0 : 1,
      };
    });

    return {
      kind: "typecheck-result",
      id: request.id,
      ok: true,
      diagnostics,
      notes: [
        ...libNotes,
        `${program.getSourceFiles().length} source file(s) in the program`,
        `${Date.now() - started}ms`,
      ],
    };
  } catch (err) {
    return {
      kind: "typecheck-result",
      id: request.id,
      ok: false,
      diagnostics: [],
      notes: libNotes,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One canonical form for every path the compiler uses */
function normalizeFileName(fileName: string): string {
  const replaced = fileName.replace(/\\/g, "/");
  const absolute = replaced.startsWith("/") ? replaced : `/${replaced}`;
  // Collapse "//" and "./" without a full path library.
  return absolute.replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/");
}

self.onmessage = (event: MessageEvent) => {
  const request = event.data as TypecheckRequest | undefined;
  if (!request || request.kind !== "typecheck") return;
  void typecheck(request).then((response) => {
    (self as unknown as { postMessage: (message: unknown) => void }).postMessage(response);
  });
};
