// ============================================================
// Chat Attachments — Read, validate & downscale
// ============================================================
// Images are read as data URLs for multimodal requests and are
// downscaled client-side so persisted conversations (and the cloud
// sync payload) stay small. Text files are inlined as fenced code
// blocks instead of attachments. Both share lib/file-import guards
// for empty/oversized/binary text reads.

import {
  MAX_IMPORT_BYTES,
  ImportFileError,
  looksBinary,
  fileExtension,
} from "@/lib/file-import";
import type { ChatAttachment } from "../types";

/** Hard per-message attachment cap */
export const MAX_ATTACHMENTS = 4;

/** Max edge length after downscale (keeps payloads ~100–300 KB) */
const MAX_IMAGE_EDGE = 1024;

/** Re-encode target bytes; larger originals fall back to JPEG quality steps */
const TARGET_IMAGE_BYTES = 300 * 1024;

/** Canvas-generated data URL from an ImageBitmap */
async function bitmapToDataUrl(
  bitmap: ImageBitmap
): Promise<{ dataUrl: string; width: number; height: number }> {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImportFileError("Could not process the image");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // JPEG first (smallest); transparent PNGs keep PNG via the fallback below
  let quality = 0.85;
  let out = canvas.toDataURL("image/jpeg", quality);
  while (out.length * 0.75 > TARGET_IMAGE_BYTES && quality > 0.5) {
    quality -= 0.15;
    out = canvas.toDataURL("image/jpeg", quality);
  }

  return { dataUrl: out, width, height };
}

/**
 * Reads one image File into a downscaled ChatAttachment.
 * Throws ImportFileError with a user-ready message on failure.
 */
export async function readImageAttachment(file: File): Promise<ChatAttachment> {
  if (file.size === 0) throw new ImportFileError(`${file.name} is empty`);
  if (!file.type.startsWith("image/") && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) {
    throw new ImportFileError(`${file.name} is not an image`);
  }
  // Generous raw cap — the downscale shrinks the stored payload anyway
  if (file.size > 25 * 1024 * 1024) {
    throw new ImportFileError(`${file.name} is too large (limit 25 MB)`);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImportFileError(`${file.name} could not be decoded`);
  }

  const { dataUrl, width, height } = await bitmapToDataUrl(bitmap);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: file.name || "image",
    size: Math.round(dataUrl.length * 0.75),
    mime: "image/jpeg",
    dataUrl,
    width,
    height,
  };
}

/**
 * Reads one text File for chat: returned as inlined fenced-markdown
 * text (not an attachment) so every model can see it.
 */
export async function readTextForChat(file: File): Promise<string> {
  if (file.size === 0) throw new ImportFileError(`${file.name} is empty`);
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportFileError(
      `${file.name} is too large (${(file.size / 1024).toFixed(0)} KB — limit 5 MB)`
    );
  }
  const head = await file.slice(0, 8192).text();
  if (looksBinary(head)) {
    throw new ImportFileError(`${file.name} is not a text file`);
  }

  const text = (await file.text()).replace(/^\uFEFF/, "");
  const ext = fileExtension(file.name);
  const fenceLang = ext && !/\s/.test(ext) ? ext : "";
  const trimmed = text.length > 60_000
    ? `${text.slice(0, 60_000)}\n… (truncated at 60,000 characters)`
    : text;

  return `\n\n**${file.name}**\n\`\`\`${fenceLang}\n${trimmed}\n\`\`\``;
}

export interface ChatImportOutcome {
  attachments: ChatAttachment[];
  /** Markdown text to append to the message (inlined text files) */
  textBlocks: string;
  rejected: Array<{ name: string; reason: string }>;
}

/** Split a file list into image attachments vs inlined text blocks */
export async function importChatFiles(files: File[]): Promise<ChatImportOutcome> {
  const attachments: ChatAttachment[] = [];
  const textBlocks: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const file of files) {
    try {
      if (file.type.startsWith("image/")) {
        attachments.push(await readImageAttachment(file));
      } else {
        textBlocks.push(await readTextForChat(file));
      }
    } catch (err) {
      rejected.push({
        name: file.name,
        reason: err instanceof Error ? err.message : "Could not be read",
      });
    }
  }

  // Enforce the per-message image cap (oldest wins)
  const overflow = attachments.length - MAX_ATTACHMENTS;
  if (overflow > 0) {
    const dropped = attachments.splice(MAX_ATTACHMENTS);
    dropped.forEach((a) =>
      rejected.push({ name: a.name, reason: `Max ${MAX_ATTACHMENTS} images per message` })
    );
  }

  return { attachments, textBlocks: textBlocks.join(""), rejected };
}
