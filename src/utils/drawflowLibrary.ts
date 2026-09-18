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

/** Fetch raw library items from local or CDN */
export async function fetchRawLibraryItems(sourcePath: string): Promise<unknown[]> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const localUrl = `${baseUrl}excalidraw-libraries/libraries/${cleanPath}`;
  const cdnUrl = `${CDN_BASE_URL}/${cleanPath}`;

  let data: Record<string, unknown> | unknown[] | null = null;

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

  const rawRecord = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const rawItems: unknown[] = rawRecord?.libraryItems && Array.isArray(rawRecord.libraryItems)
    ? (rawRecord.libraryItems as unknown[])
    : rawRecord?.library && Array.isArray(rawRecord.library)
    ? (rawRecord.library as unknown[])
    : Array.isArray(data)
    ? data
    : [];

  return rawItems;
}

/** Fetch and format library items, tagging each with metadata for reliable tracking */
export async function fetchAndFormatLibraryItems(
  sourcePath: string,
  libId?: string
): Promise<unknown[]> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const safeTag = (libId || cleanPath).replace(/[^a-zA-Z0-9_-]/g, "_");
  const rawItems = await fetchRawLibraryItems(sourcePath);

  return rawItems.map((item: unknown, idx: number) => {
    if (Array.isArray(item)) {
      return {
        id: `lib-${safeTag}-${idx}`,
        status: "published" as const,
        elements: item,
        created: Date.now(),
        _libraryId: libId,
        _librarySource: cleanPath,
      };
    } else if (typeof item === "object" && item !== null && "elements" in item) {
      const obj = item as Record<string, unknown>;
      return {
        id: (obj.id as string) || `lib-${safeTag}-${idx}`,
        status: ((obj.status as string) || "published") as "published" | "unpublished",
        elements: obj.elements,
        created: (obj.created as number) || Date.now(),
        _libraryId: libId,
        _librarySource: cleanPath,
      };
    }
    return item;
  });
}

/** Remove library items from an array in-memory */
export async function removeLibraryItemsFromList(
  currentItems: unknown[],
  sourcePath: string,
  libId?: string
): Promise<{ remainingItems: unknown[]; removedCount: number }> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const safeTag = (libId || cleanPath).replace(/[^a-zA-Z0-9_-]/g, "_");
  let rawItems: unknown[] = [];
  try {
    rawItems = await fetchRawLibraryItems(sourcePath);
  } catch {
    rawItems = [];
  }

  const libItemIds = new Set<string>();
  rawItems.forEach((item: unknown) => {
    if (typeof item === "object" && item !== null && "id" in item) {
      libItemIds.add((item as Record<string, unknown>).id as string);
    }
  });

  const libElementSignatures = new Set<string>();
  rawItems.forEach((item: unknown) => {
    if (Array.isArray(item)) {
      libElementSignatures.add(JSON.stringify(item));
    } else if (typeof item === "object" && item !== null && "elements" in item) {
      libElementSignatures.add(JSON.stringify((item as Record<string, unknown>).elements));
    }
  });

  let removedCount = 0;
  const remainingItems = currentItems.filter((existingItem: unknown) => {
    if (typeof existingItem !== "object" || existingItem === null) return true;
    const obj = existingItem as Record<string, unknown>;

    // 1. Tag match
    if (libId && obj._libraryId === libId) {
      removedCount++;
      return false;
    }
    if (cleanPath && obj._librarySource === cleanPath) {
      removedCount++;
      return false;
    }

    // 2. ID match
    if (typeof obj.id === "string") {
      if (obj.id.startsWith(`lib-${safeTag}-`)) {
        removedCount++;
        return false;
      }
      if (libItemIds.has(obj.id)) {
        removedCount++;
        return false;
      }
    }

    // 3. Signature match
    if ("elements" in obj && libElementSignatures.size > 0) {
      const sig = JSON.stringify(obj.elements);
      if (libElementSignatures.has(sig)) {
        removedCount++;
        return false;
      }
    }

    return true;
  });

  return { remainingItems, removedCount };
}

/** Load a specific library (.excalidrawlib) into an Excalidraw canvas instance with fallback */
export async function loadLibraryToExcalidraw(
  sourcePath: string,
  excalidrawAPI: ExcalidrawImperativeAPI,
  libId?: string
): Promise<number> {
  const formattedItems = await fetchAndFormatLibraryItems(sourcePath, libId);

  await excalidrawAPI.updateLibrary({
    libraryItems: formattedItems as Parameters<ExcalidrawImperativeAPI["updateLibrary"]>[0]["libraryItems"],
    merge: true,
    openLibraryMenu: true,
  });

  return formattedItems.length;
}

/** Remove a specific library's items from an Excalidraw canvas instance */
export async function removeLibraryFromExcalidraw(
  sourcePath: string,
  excalidrawAPI: ExcalidrawImperativeAPI,
  libId?: string
): Promise<number> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const safeTag = (libId || cleanPath).replace(/[^a-zA-Z0-9_-]/g, "_");
  let rawItems: unknown[] = [];
  try {
    rawItems = await fetchRawLibraryItems(sourcePath);
  } catch {
    rawItems = [];
  }

  const libItemIds = new Set<string>();
  rawItems.forEach((item: unknown) => {
    if (typeof item === "object" && item !== null && "id" in item) {
      libItemIds.add((item as Record<string, unknown>).id as string);
    }
  });

  const libElementSignatures = new Set<string>();
  rawItems.forEach((item: unknown) => {
    if (Array.isArray(item)) {
      libElementSignatures.add(JSON.stringify(item));
    } else if (typeof item === "object" && item !== null && "elements" in item) {
      libElementSignatures.add(JSON.stringify((item as Record<string, unknown>).elements));
    }
  });

  let removedCount = 0;

  // Use the callback form of updateLibrary to access current items directly
  await excalidrawAPI.updateLibrary({
    libraryItems: ((currentItems: readonly unknown[]) => {
      const filtered = (currentItems as unknown[]).filter((existingItem: unknown) => {
        if (typeof existingItem !== "object" || existingItem === null) return true;
        const obj = existingItem as Record<string, unknown>;

        // Match by tag
        if (libId && obj._libraryId === libId) {
          removedCount++;
          return false;
        }
        if (cleanPath && obj._librarySource === cleanPath) {
          removedCount++;
          return false;
        }

        // Match by ID
        if (typeof obj.id === "string") {
          if (obj.id.startsWith(`lib-${safeTag}-`)) {
            removedCount++;
            return false;
          }
          if (libItemIds.has(obj.id)) {
            removedCount++;
            return false;
          }
        }

        // Match by element content signature
        if ("elements" in obj && libElementSignatures.size > 0) {
          const sig = JSON.stringify(obj.elements);
          if (libElementSignatures.has(sig)) {
            removedCount++;
            return false;
          }
        }

        return true;
      });
      return filtered;
    }) as unknown as Parameters<ExcalidrawImperativeAPI["updateLibrary"]>[0]["libraryItems"],
    merge: false,
    openLibraryMenu: false,
  });

  return removedCount;
}

export interface ExcalidrawCategoryDef {
  id: string;
  label: string;
  keywords?: string[];
}

export const EXCALIDRAW_CATEGORIES: ExcalidrawCategoryDef[] = [
  { id: "all", label: "All Libraries" },
  { id: "added", label: "Added to DrawFlow" },
  { id: "system", label: "System Design & Cloud", keywords: ["system", "architecture", "cloud", "aws", "gcp", "azure", "kubernetes", "docker", "snowflake"] },
  { id: "ui", label: "UI & Wireframes", keywords: ["ui", "wireframe", "mobile", "android", "ios", "gadget", "component", "design"] },
  { id: "icons", label: "Icons & Logos", keywords: ["icon", "logo", "brand", "dev", "tech"] },
  { id: "diagrams", label: "Flowcharts & Diagrams", keywords: ["flowchart", "diagram", "process", "map", "mindmap", "tree", "chart"] },
];

