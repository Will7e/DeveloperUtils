// ============================================================
// Image Processing Utility for AI Chat
// ============================================================
// Handles image optimization, canvas-based resizing, base64 extraction,
// and formatting for AI providers (OpenAI, Anthropic Claude, Gemini).

import { generateId } from "@/lib/utils";
import type { ChatImageAttachment } from "../types";

const MAX_IMAGE_DIMENSION = 1920;
const COMPRESSION_QUALITY = 0.85;

/**
 * Formats byte size into human readable string (KB / MB)
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extracts raw base64 data and mime type from a data URL
 * E.g. "data:image/jpeg;base64,/9j/4AAQSk..." -> { mimeType: "image/jpeg", base64: "/9j/4AAQSk..." }
 */
export function extractBase64Data(dataUrl: string): {
  mimeType: string;
  base64: string;
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1] || "image/jpeg",
      base64: match[2] || "",
    };
  }
  // Fallback if raw base64 or custom format
  return {
    mimeType: "image/jpeg",
    base64: dataUrl.replace(/^data:[^;]+;base64,/, ""),
  };
}

/**
 * Reads a File, downscales it if exceeding MAX_IMAGE_DIMENSION,
 * and produces a compact ChatImageAttachment data URL.
 */
export async function processImageFile(
  file: File,
  maxDimension = MAX_IMAGE_DIMENSION,
  quality = COMPRESSION_QUALITY
): Promise<ChatImageAttachment> {
  const dataUrl = await readFileAsDataUrl(file);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const isOversized = width > maxDimension || height > maxDimension;

      // If within dimensions and reasonably small, use original data URL
      if (!isOversized && file.size < 800 * 1024) {
        resolve({
          id: generateId(),
          url: dataUrl,
          name: file.name || "image.png",
          mimeType: file.type || "image/png",
          size: file.size,
        });
        return;
      }

      // Calculate scaled dimensions
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        // Fallback to original data URL if 2D context fails
        resolve({
          id: generateId(),
          url: dataUrl,
          name: file.name || "image.png",
          mimeType: file.type || "image/png",
          size: file.size,
        });
        return;
      }

      ctx.drawImage(img, 0, 0, width, height);

      // Determine output mime type (use JPEG for photos or large PNGs without alpha, or preserve WebP/PNG)
      const outputType =
        file.type === "image/png" || file.type === "image/webp"
          ? file.type
          : "image/jpeg";

      const optimizedDataUrl = canvas.toDataURL(outputType, quality);
      // Rough estimate of byte size from base64 length
      const estimatedBytes = Math.round(
        (optimizedDataUrl.length - (optimizedDataUrl.indexOf(",") + 1)) * 0.75
      );

      resolve({
        id: generateId(),
        url: optimizedDataUrl,
        name: file.name || "image.png",
        mimeType: outputType,
        size: estimatedBytes,
      });
    };

    img.onerror = () => {
      reject(new Error(`Failed to load image: ${file.name}`));
    };

    img.src = dataUrl;
  });
}

/**
 * Read File object as base64 Data URL
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file as data URL"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
