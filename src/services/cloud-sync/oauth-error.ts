// ============================================================
// Cloud Sync — OAuth Error Types
// ============================================================
// Lightweight typed errors so the sync engine can distinguish
// recoverable conditions (expired token, conflict) from fatal ones.

export type OAuthErrorCode =
  | "token_expired"
  | "no_refresh_token"
  | "conflict"
  | "network";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;

  constructor(message: string, code: OAuthErrorCode) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

export function isOAuthError(err: unknown): err is OAuthError {
  return err instanceof OAuthError;
}
