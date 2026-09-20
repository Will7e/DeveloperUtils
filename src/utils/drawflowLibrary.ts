// ============================================================
// DrawFlow Library Helper — Fetch & Load Community Libraries
// ============================================================

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export interface DrawFlowLibraryItem {
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
export type ExcalidrawLibraryItem = DrawFlowLibraryItem;

let cachedLibraries: DrawFlowLibraryItem[] | null = null;

const CDN_BASE_URL = "https://cdn.jsdelivr.net/gh/excalidraw/excalidraw-libraries@main/libraries";

/** Get local preview URL using Vite BASE_URL */
export function getDrawFlowLibraryPreviewUrl(previewPath: string): string {
  const cleanPath = previewPath.startsWith("/") ? previewPath.slice(1) : previewPath;
  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${baseUrl}drawflow-libraries/libraries/${cleanPath}`;
}
export const getExcalidrawLibraryPreviewUrl = getDrawFlowLibraryPreviewUrl;

/** Get fallback CDN preview URL */
export function getDrawFlowLibraryCdnPreviewUrl(previewPath: string): string {
  const cleanPath = previewPath.startsWith("/") ? previewPath.slice(1) : previewPath;
  return `${CDN_BASE_URL}/${cleanPath}`;
}
export const getExcalidrawLibraryCdnPreviewUrl = getDrawFlowLibraryCdnPreviewUrl;

/** Fetch all community DrawFlow libraries metadata with local -> CDN fallback */
export async function getDrawFlowLibraries(): Promise<DrawFlowLibraryItem[]> {
  if (cachedLibraries) return cachedLibraries;

  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const localUrl = `${baseUrl}drawflow-libraries/libraries.json`;
  const cdnUrl = "https://cdn.jsdelivr.net/gh/excalidraw/excalidraw-libraries@main/libraries.json";

  // Try local first
  try {
    const res = await fetch(localUrl);
    const contentType = res.headers.get("content-type") || "";
    if (res.ok && !contentType.includes("text/html")) {
      const text = await res.text();
      const data: DrawFlowLibraryItem[] = JSON.parse(text);
      if (Array.isArray(data) && data.length > 0) {
        cachedLibraries = data;
        return data;
      }
    }
  } catch (e) {
    console.warn("Local DrawFlow libraries fetch failed, falling back to CDN...", e);
  }

  // Fallback to CDN
  try {
    const res = await fetch(cdnUrl);
    if (!res.ok) throw new Error(`CDN fetch failed with status ${res.status}`);
    const data: DrawFlowLibraryItem[] = await res.json();
    cachedLibraries = data;
    return data;
  } catch (err) {
    console.error("Error loading DrawFlow libraries from local & CDN:", err);
    return [];
  }
}
export const getExcalidrawLibraries = getDrawFlowLibraries;

/** Fetch raw library items from local or CDN */
export async function fetchRawLibraryItems(sourcePath: string): Promise<unknown[]> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const localUrl = `${baseUrl}drawflow-libraries/libraries/${cleanPath}`;
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
  let rawItems: unknown[];
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

/** Load a specific library into an canvas instance with fallback */
export async function loadLibraryToDrawFlow(
  sourcePath: string,
  canvasAPI: ExcalidrawImperativeAPI,
  libId?: string
): Promise<number> {
  const formattedItems = await fetchAndFormatLibraryItems(sourcePath, libId);

  await canvasAPI.updateLibrary({
    libraryItems: formattedItems as Parameters<ExcalidrawImperativeAPI["updateLibrary"]>[0]["libraryItems"],
    merge: true,
    openLibraryMenu: true,
  });

  return formattedItems.length;
}
export const loadLibraryToExcalidraw = loadLibraryToDrawFlow;

/** Remove a specific library's items from a canvas instance */
export async function removeLibraryFromDrawFlow(
  sourcePath: string,
  canvasAPI: ExcalidrawImperativeAPI,
  libId?: string
): Promise<number> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const safeTag = (libId || cleanPath).replace(/[^a-zA-Z0-9_-]/g, "_");
  let rawItems: unknown[];
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
  await canvasAPI.updateLibrary({
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
export const removeLibraryFromExcalidraw = removeLibraryFromDrawFlow;

export interface DrawFlowCategoryDef {
  id: string;
  label: string;
  keywords?: string[];
}
export type ExcalidrawCategoryDef = DrawFlowCategoryDef;

export const DRAWFLOW_CATEGORIES: DrawFlowCategoryDef[] = [
  { id: "all", label: "All Libraries" },
  { id: "added", label: "Added to DrawFlow" },
  { id: "system", label: "System Design & Cloud", keywords: ["system", "architecture", "cloud", "aws", "gcp", "azure", "kubernetes", "docker", "snowflake"] },
  { id: "ui", label: "UI & Wireframes", keywords: ["ui", "wireframe", "mobile", "android", "ios", "gadget", "component", "design"] },
  { id: "icons", label: "Icons & Logos", keywords: ["icon", "logo", "brand", "dev", "tech"] },
  { id: "diagrams", label: "Flowcharts & Diagrams", keywords: ["flowchart", "diagram", "process", "map", "mindmap", "tree", "chart"] },
];
export const EXCALIDRAW_CATEGORIES = DRAWFLOW_CATEGORIES;
