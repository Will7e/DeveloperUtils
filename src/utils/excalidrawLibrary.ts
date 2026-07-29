// ============================================================
// Excalidraw Library Helper — Fetch & Load Community Libraries
// ============================================================

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export interface ExcalidrawLibraryItem {
  id: string;
  name: string;
  description: string;
  authors: Array<{ name: string; url: string }>;
  source: string;
  preview: string;
  created: string;
  updated: string;
  version: number;
}

let cachedLibraries: ExcalidrawLibraryItem[] | null = null;

const CDN_BASE_URL = "https://cdn.jsdelivr.net/gh/excalidraw/excalidraw-libraries@main/libraries";

/** Get local preview URL using Vite BASE_URL */
export function getExcalidrawLibraryPreviewUrl(previewPath: string): string {
  const cleanPath = previewPath.startsWith("/") ? previewPath.slice(1) : previewPath;
  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${baseUrl}excalidraw-libraries/libraries/${cleanPath}`;
}

/** Get fallback CDN preview URL */
export function getExcalidrawLibraryCdnPreviewUrl(previewPath: string): string {
  const cleanPath = previewPath.startsWith("/") ? previewPath.slice(1) : previewPath;
  return `${CDN_BASE_URL}/${cleanPath}`;
}

/** Fetch all community Excalidraw libraries metadata with local -> CDN fallback */
export async function getExcalidrawLibraries(): Promise<ExcalidrawLibraryItem[]> {
  if (cachedLibraries) return cachedLibraries;

  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const localUrl = `${baseUrl}excalidraw-libraries/libraries.json`;
  const cdnUrl = "https://cdn.jsdelivr.net/gh/excalidraw/excalidraw-libraries@main/libraries.json";

  // Try local first
  try {
    const res = await fetch(localUrl);
    const contentType = res.headers.get("content-type") || "";
    if (res.ok && !contentType.includes("text/html")) {
      const text = await res.text();
      const data: ExcalidrawLibraryItem[] = JSON.parse(text);
      if (Array.isArray(data) && data.length > 0) {
        cachedLibraries = data;
        return data;
      }
    }
  } catch (e) {
    console.warn("Local Excalidraw libraries fetch failed, falling back to CDN...", e);
  }

  // Fallback to CDN
  try {
    const res = await fetch(cdnUrl);
    if (!res.ok) throw new Error(`CDN fetch failed with status ${res.status}`);
    const data: ExcalidrawLibraryItem[] = await res.json();
    cachedLibraries = data;
    return data;
  } catch (err) {
    console.error("Error loading Excalidraw libraries from local & CDN:", err);
    return [];
  }
}

/** Load a specific library (.excalidrawlib) into an Excalidraw canvas instance with fallback */
export async function loadLibraryToExcalidraw(
  sourcePath: string,
  excalidrawAPI: ExcalidrawImperativeAPI
): Promise<number> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const localUrl = `${baseUrl}excalidraw-libraries/libraries/${cleanPath}`;
  const cdnUrl = `${CDN_BASE_URL}/${cleanPath}`;

  let data: any = null;

  // Try local fetch first
  try {
    const res = await fetch(localUrl);
    const contentType = res.headers.get("content-type") || "";
    if (res.ok && !contentType.includes("text/html")) {
      const text = await res.text();
      data = JSON.parse(text);
    }
  } catch {
    // Ignore local error and fall back to CDN
  }

  // Fallback to CDN if local fetch failed or returned invalid JSON
  if (!data) {
    const res = await fetch(cdnUrl);
    if (!res.ok) throw new Error(`Failed to load library from CDN at ${cleanPath}`);
    data = await res.json();
  }

  const rawItems = data.libraryItems || data.library || (Array.isArray(data) ? data : []);

  const formattedItems = rawItems.map((item: any, idx: number) => {
    if (Array.isArray(item)) {
      return {
        id: `lib-item-${Date.now()}-${idx}`,
        status: "published",
        elements: item,
        created: Date.now(),
      };
    } else if (item?.elements) {
      return {
        id: item.id || `lib-item-${Date.now()}-${idx}`,
        status: item.status || "published",
        elements: item.elements,
        created: item.created || Date.now(),
      };
    }
    return item;
  });

  await excalidrawAPI.updateLibrary({
    libraryItems: formattedItems,
    merge: true,
    openLibraryMenu: true,
  });

  return formattedItems.length;
}

