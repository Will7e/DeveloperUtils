// ============================================================
// Auth Service — Stub for future authentication
// ============================================================
// This is a no-op stub. When backend auth is implemented,
// replace this with a real service (e.g., Firebase, Supabase,
// or custom JWT auth) without changing any UI code.
// ============================================================

import type { IAuthService } from "@/types";

export class StubAuthService implements IAuthService {
  isAuthenticated(): boolean {
    return false;
  }

  async login(_credentials: { email: string; password: string }): Promise<void> {
    console.warn("[AuthService] Auth not implemented yet");
  }

  async logout(): Promise<void> {
    console.warn("[AuthService] Auth not implemented yet");
  }

  getUser() {
    return null;
  }
}

export const authService = new StubAuthService();
