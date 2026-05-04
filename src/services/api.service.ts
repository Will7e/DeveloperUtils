// ============================================================
// API Service — Stub for future backend API
// ============================================================

import type { IAPIService } from "@/types";

export class StubAPIService implements IAPIService {
  private baseUrl = "";

  async get<T>(_url: string): Promise<T> {
    throw new Error("[APIService] Not implemented — no backend configured");
  }

  async post<T>(_url: string, _data: unknown): Promise<T> {
    throw new Error("[APIService] Not implemented — no backend configured");
  }

  async put<T>(_url: string, _data: unknown): Promise<T> {
    throw new Error("[APIService] Not implemented — no backend configured");
  }

  async delete(_url: string): Promise<void> {
    throw new Error("[APIService] Not implemented — no backend configured");
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  getBaseUrl() {
    return this.baseUrl;
  }
}

export const apiService = new StubAPIService();
