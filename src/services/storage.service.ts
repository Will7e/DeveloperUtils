// ============================================================
// Storage Service — Browser-local storage via localStorage
// ============================================================
// Implements IStorageService. Swap to an API-backed service
// for cloud persistence with zero UI changes.
// ============================================================

import type { EditorFile, IStorageService } from "@/types";

const STORAGE_KEY = "codeforge_files";

export class LocalStorageService implements IStorageService {
  async saveFile(file: EditorFile): Promise<void> {
    const files = await this.listFiles();
    const index = files.findIndex((f) => f.id === file.id);
    if (index >= 0) {
      files[index] = file;
    } else {
      files.push(file);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  }

  async loadFile(id: string): Promise<EditorFile | null> {
    const files = await this.listFiles();
    return files.find((f) => f.id === id) ?? null;
  }

  async listFiles(): Promise<EditorFile[]> {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async deleteFile(id: string): Promise<void> {
    const files = await this.listFiles();
    const filtered = files.filter((f) => f.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  }
}

export const storageService = new LocalStorageService();
