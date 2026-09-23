// ============================================================
// GitHub Session — A Token That Stopped Working Says So
// ============================================================
// The connected state was derived from ONE thing: whether a token string was
// stored. Nothing ever asked GitHub whether it still worked, so a token that
// had expired, been revoked, or lost access to the organization kept the chat
// header and the settings tab showing "Connected as <login>" indefinitely —
// while every repository call failed with messages the user read as "the
// agent is broken".
//
// Two moments matter, and both are handled here:
//   • On load — the stored token is validated ONCE per page load. GitHub
//     refusing it clears the session and says why; being unreachable (offline,
//     proxy down) clears nothing, because that is not the same fact.
//   • On use — any 401 from the GitHub client reports the refusal
//     (lib/github-client.ts), so a token revoked mid-session cannot keep
//     looking live until the next reload.
// ============================================================

import { getAuthenticatedUser, GitHubError, invalidateRepoCache, onGitHubCredentialRefused } from "../lib/github-client";
import { useAppStore } from "@/stores/app.store";
import { useChatStore } from "@/stores/chat.store";
import type { GitHubSettings } from "../types";

/** What the app shows the user when GitHub stops accepting the stored token. */
export const GITHUB_SESSION_LOST_NOTE =
  "GitHub no longer accepts your saved token — reconnect it in Settings › GitHub.";

export type GitHubSessionCheck =
  | { status: "none" }
  | { status: "valid" }
  /** Could not ask GitHub (offline / proxy). Says nothing about the token. */
  | { status: "unknown"; message: string }
  /** GitHub itself refused the credential. */
  | { status: "lost"; message: string };

/**
 * True when GitHub refused the CREDENTIAL, as opposed to the request.
 *
 * 401 is the credential; 403 on `/user` is a token GitHub will not act on at
 * all (blocked, revoked app, SSO). Both leave the account unusable until it is
 * reconnected, and both are the states that used to look connected.
 */
export function isCredentialRefusal(err: unknown): boolean {
  if (!(err instanceof GitHubError)) return false;
  return err.code === "unauthorized" || err.code === "forbidden";
}

/** Asks GitHub whether the stored token still works. Never throws. */
export async function checkGitHubSession(
  github: GitHubSettings | undefined
): Promise<GitHubSessionCheck> {
  const token = github?.token?.trim();
  if (!token) return { status: "none" };
  try {
    await getAuthenticatedUser(token);
    return { status: "valid" };
  } catch (err) {
    if (isCredentialRefusal(err)) return { status: "lost", message: GITHUB_SESSION_LOST_NOTE };
    return {
      status: "unknown",
      message: err instanceof Error ? err.message : "Could not reach GitHub.",
    };
  }
}

/**
 * Drops the stored GitHub session and tells the user.
 *
 * Idempotent by construction: the token it clears is the condition it checks,
 * so the second call (a retry storm of 401s, two chats both failing) says
 * nothing and toasts nothing.
 */
export function forgetGitHubSession(message: string = GITHUB_SESSION_LOST_NOTE): void {
  const store = useChatStore.getState();
  if (!store.settings.github?.token) return;

  store.updateSettings({
    github: { token: "", mode: null, login: null, avatarUrl: null, connectedAt: null },
  });
  invalidateRepoCache();
  useAppStore.getState().addToast({ message, type: "error", duration: 8000 });
}

/**
 * Starts watching the session: validates the stored token once, then reacts to
 * the client's own credential refusals. Safe to call more than once (React
 * StrictMode mounts twice) — the load-time check runs once per page load.
 */
let loadCheckStarted = false;

export function watchGitHubSession(): void {
  // Set before the await so a second mount cannot start a second request.
  onGitHubCredentialRefused((message) => forgetGitHubSession(message));
  if (loadCheckStarted) return;
  loadCheckStarted = true;

  void checkGitHubSession(useChatStore.getState().settings.github).then((result) => {
    if (result.status === "lost") forgetGitHubSession(result.message);
  });
}

/** Test seam: lets a test drive the once-per-load check again. */
export function resetGitHubSessionWatchForTests(): void {
  loadCheckStarted = false;
  onGitHubCredentialRefused(null);
}
