// ============================================================
// GitHub Session — Refused Is Not The Same As Unreachable
// ============================================================
// The bug: "connected" meant "a token string is stored", so a revoked or
// expired token kept the header and the settings tab claiming a live session
// while every repository call failed.
//
// The distinction these tests defend is the one an over-eager fix gets wrong:
// clearing the session when GitHub is merely UNREACHABLE would sign a user out
// for being on a plane. Only GitHub refusing the credential ($status 401/403)
// may clear it.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn());

vi.mock("../lib/github-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/github-client")>()),
  getAuthenticatedUser: getUser,
}));

import {
  checkGitHubSession,
  forgetGitHubSession,
  GITHUB_SESSION_LOST_NOTE,
  isCredentialRefusal,
} from "./github-session";
import { GitHubError } from "../lib/github-client";
import { useChatStore } from "@/stores/chat.store";
import { useAppStore } from "@/stores/app.store";
import type { GitHubSettings } from "../types";

const CONNECTED: GitHubSettings = {
  token: "ghp_example",
  mode: "pat",
  login: "william",
  avatarUrl: null,
  connectedAt: 1_000,
};

beforeEach(() => {
  getUser.mockReset();
  useChatStore.getState().updateSettings({ github: { ...CONNECTED } });
});

describe("checkGitHubSession", () => {
  it("says nothing about a token when there is none to check", async () => {
    useChatStore.getState().updateSettings({
      github: { token: "", mode: null, login: null, avatarUrl: null, connectedAt: null },
    });

    expect(await checkGitHubSession(useChatStore.getState().settings.github)).toEqual({
      status: "none",
    });
    expect(getUser).not.toHaveBeenCalled();
  });

  it("confirms a token GitHub still accepts", async () => {
    getUser.mockResolvedValue({ login: "william", avatarUrl: null });

    expect(await checkGitHubSession(CONNECTED)).toEqual({ status: "valid" });
  });

  it("reports a refused token as lost, with the fix", async () => {
    getUser.mockRejectedValue(
      new GitHubError("GitHub token is invalid or expired.", 401, "unauthorized")
    );

    const result = await checkGitHubSession(CONNECTED);

    expect(result.status).toBe("lost");
    if (result.status === "lost") expect(result.message).toBe(GITHUB_SESSION_LOST_NOTE);
  });

  it("treats a blocked token (403) as lost too", async () => {
    // GitHub will not act on this credential at all: no request to fix.
    getUser.mockRejectedValue(new GitHubError("refused", 403, "forbidden"));

    expect((await checkGitHubSession(CONNECTED)).status).toBe("lost");
  });

  it("keeps the session when GitHub is simply unreachable", async () => {
    // Offline is not a revoked token. Clearing here would sign a user out of a
    // working account for the crime of being on a plane.
    getUser.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await checkGitHubSession(CONNECTED);

    expect(result.status).toBe("unknown");
    expect(useChatStore.getState().settings.github.token).toBe("ghp_example");
  });

  it("keeps the session when GitHub is rate limiting us", async () => {
    getUser.mockRejectedValue(new GitHubError("rate limited", 403, "rate_limited"));

    expect((await checkGitHubSession(CONNECTED)).status).toBe("unknown");
    expect(useChatStore.getState().settings.github.token).toBe("ghp_example");
  });
});

describe("isCredentialRefusal", () => {
  it("is true only for the codes that mean the credential", () => {
    expect(isCredentialRefusal(new GitHubError("x", 401, "unauthorized"))).toBe(true);
    expect(isCredentialRefusal(new GitHubError("x", 403, "forbidden"))).toBe(true);
    expect(isCredentialRefusal(new GitHubError("x", 403, "rate_limited"))).toBe(false);
    expect(isCredentialRefusal(new GitHubError("x", 404, "not_found"))).toBe(false);
    expect(isCredentialRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isCredentialRefusal(null)).toBe(false);
  });
});

describe("forgetGitHubSession", () => {
  it("clears the connection and names the reason", () => {
    const before = useAppStore.getState().toasts.length;

    forgetGitHubSession(GITHUB_SESSION_LOST_NOTE);

    const github = useChatStore.getState().settings.github;
    expect(github.token).toBe("");
    expect(github.login).toBeNull();
    expect(github.mode).toBeNull();
    expect(github.connectedAt).toBeNull();
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(before + 1);
    expect(toasts[toasts.length - 1]!.message).toBe(GITHUB_SESSION_LOST_NOTE);
  });

  it("says it once, however many calls fail", () => {
    // A revoked token makes EVERY in-flight repository call fail at the same
    // moment; one toast is information, six is an attack.
    forgetGitHubSession();
    const after = useAppStore.getState().toasts.length;

    forgetGitHubSession();
    forgetGitHubSession();

    expect(useAppStore.getState().toasts).toHaveLength(after);
  });
});
