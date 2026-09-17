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

  const formattedItems = rawItems.map((item: unknown, idx: number) => {
    if (Array.isArray(item)) {
      return {
        id: `lib-item-${Date.now()}-${idx}`,
        status: "published" as const,
        elements: item,
        created: Date.now(),
      };
    } else if (typeof item === "object" && item !== null && "elements" in item) {
      const obj = item as Record<string, unknown>;
      return {
        id: (obj.id as string) || `lib-item-${Date.now()}-${idx}`,
        status: ((obj.status as string) || "published") as "published" | "unpublished",
        elements: obj.elements,
        created: (obj.created as number) || Date.now(),
      };
    }
    return item;
  });

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
  excalidrawAPI: ExcalidrawImperativeAPI
): Promise<number> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const baseUrl = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const localUrl = `${baseUrl}excalidraw-libraries/libraries/${cleanPath}`;
  const cdnUrl = `${CDN_BASE_URL}/${cleanPath}`;

  let data: Record<string, unknown> | unknown[] | null = null;

  try {
    const res = await fetch(localUrl);
    const contentType = res.headers.get("content-type") || "";
    if (res.ok && !contentType.includes("text/html")) {
      const text = await res.text();
      data = JSON.parse(text);
    }
  } catch {
    // fall through to CDN
  }

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

  // Collect the IDs of items in this library to remove
  const libItemIds = new Set<string>();
  rawItems.forEach((item: unknown) => {
    if (typeof item === "object" && item !== null && "id" in item) {
      libItemIds.add((item as Record<string, unknown>).id as string);
    }
  });

  // Build a set of element JSON signatures for array-type items (fallback matching)
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
    libraryItems: ((currentItems: unknown[]) => {
      const filtered = currentItems.filter((existingItem: unknown) => {
        if (typeof existingItem !== "object" || existingItem === null) return true;
        const obj = existingItem as Record<string, unknown>;

        // Match by ID
        if ("id" in obj && typeof obj.id === "string" && libItemIds.has(obj.id)) {
          removedCount++;
          return false;
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
    }) as Parameters<ExcalidrawImperativeAPI["updateLibrary"]>[0]["libraryItems"],
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
  { id: "system", label: "System Design & Cloud", keywords: ["system", "architecture", "cloud", "aws", "gcp", "azure", "kubernetes", "docker", "snowflake"] },
  { id: "ui", label: "UI & Wireframes", keywords: ["ui", "wireframe", "mobile", "android", "ios", "gadget", "component", "design"] },
  { id: "icons", label: "Icons & Logos", keywords: ["icon", "logo", "brand", "dev", "tech"] },
  { id: "diagrams", label: "Flowcharts & Diagrams", keywords: ["flowchart", "diagram", "process", "map", "mindmap", "tree", "chart"] },
];

