// ============================================================
// VaultGuard — Automatic Transparent Encryption Provider
// ============================================================
// Initializes the automatic AES-256-GCM encryption vault on app mount
// and immediately renders child routes without blocking or asking
// users for passwords.

import { useEffect } from "react";
import { useVaultStore } from "@/services/vault.service";

export function VaultGuard({ children }: { children: React.ReactNode }) {
  const initAutomaticVault = useVaultStore((s) => s.initAutomaticVault);

  useEffect(() => {
    initAutomaticVault();
  }, [initAutomaticVault]);

  return <>{children}</>;
}
