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

/** Fetch all community Excalidraw libraries metadata */
export async function getExcalidrawLibraries(): Promise<ExcalidrawLibraryItem[]> {
  if (cachedLibraries) return cachedLibraries;

  try {
    const res = await fetch("/excalidraw-libraries/libraries.json");
    if (!res.ok) throw new Error("Failed to fetch libraries.json");
    const data: ExcalidrawLibraryItem[] = await res.json();
    cachedLibraries = data;
    return data;
  } catch (err) {
    console.error("Error loading Excalidraw libraries:", err);
    return [];
  }
}

/** Load a specific library (.excalidrawlib) into an Excalidraw canvas instance */
export async function loadLibraryToExcalidraw(
  sourcePath: string,
  excalidrawAPI: ExcalidrawImperativeAPI
): Promise<number> {
  const cleanPath = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  const res = await fetch(`/excalidraw-libraries/libraries/${cleanPath}`);
  if (!res.ok) throw new Error(`Failed to load library at ${cleanPath}`);

  const data = await res.json();
  const rawItems = data.libraryItems || data.library || (Array.isArray(data) ? data : []);

  const formattedItems = rawItems.map((item: any, idx: number) => {
    if (Array.isArray(item)) {
      return {
        id: `lib-item-${Date.now()}-${idx}`,
        status: "published",
        elements: item,
        created: Date.now(),
      };
    } else if (item.elements) {
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
