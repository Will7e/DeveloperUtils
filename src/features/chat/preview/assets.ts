// ============================================================
// Preview Assets — What a Workspace File IS, and How to Carry It
// ============================================================
// The workspace holds TEXT. The bundler used to hand every file it could
// not recognise to esbuild as JavaScript, which is how a committed image
// produced
//
//     vfs:src/assets/Vietnamese-food.webp:1
//     Expected ";" but found "\x14"
//
// — an error quoting a byte offset INSIDE an image, with nothing saying a
// webp was the problem at all. This module owns the decision that was
// missing: given a path, what is it?
//
//   • asset     — carried as a data URL built from the file's real bytes
//     (images, fonts, media). Never parsed as source.
//   • code      — compiled by esbuild under its own loader (ts/tsx/js/
//     jsx/css/json), which is what `previewLoaderFor` is for.
//   • plain text — `text`, so importing one cannot fail the build.
//   • unknown   — refused BY NAME, because a diagnostic that names the
//     file is worth more than one that quotes it.
//
// Pure: no network, no store, no wasm. `Loader` is a type-only import, so
// importing this from a test costs nothing.
// ============================================================

import type { Loader } from "esbuild-wasm";

/** The extension of a path, lowercased ("" when it has none) */
export function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  // A leading dot is the dotfile's NAME, not an extension — except when
  // the name IS the format (`.env`, `.gitignore`). Those still have to be
  // classified, because the thing being avoided is parsing them as source.
  if (dot === 0) return base.slice(1).toLowerCase();
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * MIME type for an extension the preview can carry as a data URL.
 *
 * The list is deliberately the browser-native set — formats a browser
 * renders without a build step. Anything needing a transform (JSX in an
 * SVG, an icon sprite pipeline) is not in here, and its import will be
 * reported rather than silently mangled.
 */
const ASSET_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** MIME type when the preview carries this path as a data URL, else null */
export function assetMimeType(path: string): string | null {
  return ASSET_MIME_TYPES[extensionOf(path)] ?? null;
}

/** True when a path's bytes (not its text) are what the browser needs */
export function isAssetPath(path: string): boolean {
  return assetMimeType(path) !== null;
}

/** Source extensions esbuild compiles under a dedicated loader */
const CODE_LOADERS: Record<string, Loader> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  css: "css",
  json: "json",
};

/**
 * Text formats with no build step. They are `text` rather than `js`
 * because the old fallback made `import raw from "./notes.md"` a syntax
 * error inside a perfectly valid markdown file.
 */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "mdx",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  "xml",
  "html",
  "htm",
  "csv",
  "tsv",
  "log",
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "graphql",
  "gql",
  "lock",
  "map",
  "gitignore",
  "editorconfig",
]);

/**
 * The loader esbuild should use for a workspace path, or null when the
 * preview has no honest way to load it.
 *
 * Returning null is the point of this function. The expression it
 * replaces ended in `: "js"`, so EVERY unrecognised extension — an image,
 * a font, a lockfile, a binary blob — was parsed as JavaScript and failed
 * with a message about the file's contents instead of its type. A null
 * becomes a diagnostic that names the file, and the build reports what it
 * could not do rather than quoting a stray byte.
 */
export function previewLoaderFor(path: string): Loader | null {
  if (assetMimeType(path) !== null) return "dataurl";
  // CSS Modules. esbuild applies its `local-css` loader to `.module.css` on
  // its own, but only through its DEFAULT loader map — and this function
  // always answers explicitly, so the default never gets a chance. Forcing
  // `css` meant `import styles from "./Hero.module.css"` had no class-name
  // mapping at all: every `styles.hero` was undefined, the markup rendered
  // with no classes, and an app whose layout lives in CSS modules looked
  // broken while every build reported success.
  if (/\.module\.css$/i.test(path)) return "local-css";
  const ext = extensionOf(path);
  const code = CODE_LOADERS[ext];
  if (code !== undefined) return code;
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

/**
 * Bytes of a base64 payload (the encoding GitHub's Contents API uses).
 *
 * Typed as ArrayBuffer-backed on purpose: these bytes go straight into a
 * `Blob` (and into esbuild), and a view that might be SharedArrayBuffer-
 * backed is not a `BlobPart`.
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Base64 of raw bytes.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a megabyte file passes
 * one argument per byte and blows the argument limit — and the failure mode
 * for the asset that finally got big enough would be a stack overflow in the
 * middle of a build.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Base64 of text, UTF-8 encoded (`btoa` alone throws on non-Latin1) */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** A data URL carrying text under a MIME type */
export function textDataUrl(text: string, mime: string): string {
  return `data:${mime};base64,${textToBase64(text)}`;
}

/** A data URL carrying bytes, from bytes or from an existing base64 payload */
export function bytesDataUrl(payload: Uint8Array | string, mime: string): string {
  return `data:${mime};base64,${
    typeof payload === "string" ? payload.replace(/\s+/g, "") : bytesToBase64(payload)
  }`;
}

/**
 * Carries ONE local reference into a preview document.
 *
 * The decision lives here, not inline in the document builder, because it is
 * a decision that was wrong: a static site's images, stylesheets and scripts
 * were handed to the browser as `blob:` URLs created in the APP's origin, and
 * a blob URL belongs to the origin that made it — so a preview served from
 * its own origin could load none of them (broken images, no styles, no
 * scripts) while every build reported success. A data URL travels inside the
 * document, so it works on both delivery paths.
 *
 * Null means "could not carry it": the asset has no bytes (never fetched, or
 * over the Contents API's 1 MB limit) or the file is not in the workspace.
 * Callers report that BY NAME rather than emitting a reference that fails
 * silently in the frame.
 */
export async function inlineReference(
  resolvedPath: string,
  providers: {
    /** Raw bytes of an asset path, or null when they are not available */
    bytes: (path: string) => Promise<Uint8Array | null>;
    /** Text of a source path, or null when it is not in the workspace */
    text: (path: string) => string | null;
  }
): Promise<string | null> {
  const mime = assetMimeType(resolvedPath);
  if (mime) {
    const bytes = await providers.bytes(resolvedPath);
    // An empty byte string is a broken image, not a blank one.
    if (!bytes || bytes.length === 0) return null;
    return bytesDataUrl(bytes, mime);
  }
  const content = providers.text(resolvedPath);
  if (content === null) return null;
  return textDataUrl(content, /\.css$/i.test(resolvedPath) ? "text/css" : "text/javascript");
}

/**
 * A 1×1 transparent PNG.
 *
 * Stands in for an image the preview could not inline (not fetched yet, or
 * over the Contents API's 1 MB limit). Rendering an empty box with a
 * diagnostic that names the file beats failing the whole build over one
 * missing asset — and an empty byte string would be a broken image, not a
 * blank one.
 */
export const TRANSPARENT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

export const TRANSPARENT_PNG_BYTES: Uint8Array<ArrayBuffer> = base64ToBytes(
  TRANSPARENT_PNG_BASE64
);

/**
 * Bytes to hand esbuild when an asset could not be fetched: a blank image
 * for images, nothing at all for everything else (a font or a video has
 * no meaningful blank form, and the diagnostic carries the explanation).
 */
export function placeholderBytesFor(path: string): Uint8Array<ArrayBuffer> {
  return assetMimeType(path)?.startsWith("image/") ? TRANSPARENT_PNG_BYTES : new Uint8Array(0);
}
