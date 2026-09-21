// ============================================================
// File Import — Shared text-file reader for drag & drop / pickers
// ============================================================
// Every tool that accepts dropped files routes through here so the
// guards and error messages stay identical:
//   • Empty files → rejected
//   • Binary files (NUL-byte sniff) → rejected
//   • Oversized files → rejected (persisted tool content shares the
//     ~5 MB localStorage quota)

/** Persisted tool content shares the ~5 MB localStorage quota */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ImportedFile {
  name: string;
  text: string;
  size: number;
}

export interface ImportOutcome {
  imported: ImportedFile[];
  rejected: Array<{ name: string; reason: string }>;
}

/** How many files one drop/pick is allowed to load at once */
export const MAX_IMPORT_FILES = 20;

/** Extract a lowercase extension (without dot) from a filename */
export function fileExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx !== -1 ? name.slice(idx + 1).toLowerCase() : "";
}

/** Strip the extension from a filename for display/tab names */
export function baseFileName(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx !== -1 ? name.slice(0, idx) : name;
}

/**
 * Detects binary payloads. Reading the first 8 KB and checking for
 * NUL bytes catches virtually every binary format (images, archives,
 * executables, UTF-16 text with BOM) while never false-positiving on
 * real UTF-8 text.
 */
export function looksBinary(sample: string): boolean {
  return sample.includes("\u0000");
}

/** Error thrown by readImportedFile with a user-ready message */
export class ImportFileError extends Error {}

/**
 * Reads one File as UTF-8 text with the shared guards applied.
 * Throws ImportFileError with a message ready for toasts.
 */
export async function readImportedFile(
  file: File,
  maxSizeBytes: number = MAX_IMPORT_BYTES
): Promise<ImportedFile> {
  if (file.size === 0) {
    throw new ImportFileError(`${file.name} is empty`);
  }
  if (file.size > maxSizeBytes) {
    const limit = maxSizeBytes >= 1024 * 1024
      ? `${Math.round(maxSizeBytes / (1024 * 1024))} MB`
      : `${Math.round(maxSizeBytes / 1024)} KB`;
    throw new ImportFileError(
      `${file.name} is too large (${(file.size / 1024).toFixed(0)} KB — limit ${limit})`
    );
  }

  // Sniff the head for binary payloads before decoding the full file
  const head = await file.slice(0, 8192).text();
  if (looksBinary(head)) {
    throw new ImportFileError(`${file.name} is not a text file`);
  }

  const text = (await file.text()).replace(/^\uFEFF/, "");
  return { name: file.name, text, size: file.size };
}

/**
 * Reads a batch of files, tolerating individual failures. Never
 * throws — rejections come back in `rejected` with user-ready
 * reasons. Files beyond MAX_IMPORT_FILES are ignored.
 */
export async function importTextFiles(
  files: File[],
  maxSizeBytes: number = MAX_IMPORT_BYTES
): Promise<ImportOutcome> {
  const imported: ImportedFile[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const file of files.slice(0, MAX_IMPORT_FILES)) {
    try {
      imported.push(await readImportedFile(file, maxSizeBytes));
    } catch (err) {
      rejected.push({
        name: file.name,
        reason: err instanceof Error ? err.message : "Could not be read",
      });
    }
  }

  return { imported, rejected };
}

// ── Extension → target routing ──────────────────────────────

/** Extensions that map onto the 6 compiler languages */
const LANGUAGE_EXTS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  py: "python",
  pyw: "python",
  html: "html",
  htm: "html",
  sql: "sql",
  lua: "lua",
};

/** Language for a filename, or null when the extension is unsupported */
export function languageFromFilename(name: string): string | null {
  return LANGUAGE_EXTS[fileExtension(name)] ?? null;
}

/** Kind for formatter/comparator routing */
export type FileFormatKind = "json" | "xml" | "env" | "list";

/** Formats with a dedicated formatter type */
export function formatterKindFromFilename(name: string): "json" | "xml" {
  const ext = fileExtension(name);
  if (ext === "json" || ext === "jsonc" || ext === "json5") return "json";
  return "xml";
}

/** Data kind for comparator mode routing */
export function comparatorKindFromFilename(name: string): FileFormatKind {
  const ext = fileExtension(name);
  if (ext === "env" || ext === "properties" || ext === "ini") return "env";
  if (ext === "json" || ext === "jsonc") return "json";
  if (ext === "xml" || ext === "svg") return "xml";
  return "list";
}
