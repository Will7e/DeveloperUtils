// ============================================================
// Cloud Sync — OAuth flow unit tests
// ============================================================
// Covers the authorize-URL contract for both providers (the shape the
// provider consoles validate against), the Microsoft SPA redirect-URI
// constraint that motivated dropping `response_mode=query`, and the
// origin gate on relayed callback messages.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  consumeOAuthResult,
  describeMicrosoftAuthorizeError,
  waitForOAuthResult,
} from "./pkce";

const ORIGIN = "https://app.test";
const REDIRECT = `${ORIGIN}/oauth/callback.html`;

/** Node has no `window`: a real EventTarget (branded, so addEventListener
 * works in Node) dressed with the timer and location members the OAuth wait
 * loop touches. */
function makeWindowStub() {
  return Object.assign(new EventTarget(), {
    location: { origin: ORIGIN },
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: unknown) => clearInterval(id as Parameters<typeof clearInterval>[0]),
  });
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  vi.stubGlobal("window", makeWindowStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildAuthorizeUrl — Google Drive", () => {
  it("requests offline access with consent and PKCE S256", async () => {
    const url = new URL(
      await buildAuthorizeUrl({
        provider: "googledrive",
        clientId: "google-client",
        redirectUri: REDIRECT,
        scopes: "https://www.googleapis.com/auth/drive.appdata",
        state: "st-1",
        verifier: "v".repeat(43),
      })
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("st-1");
  });
});

describe("buildAuthorizeUrl — OneDrive", () => {
  // Microsoft redirect URIs registered as platform "SPA" are REQUIRED to
  // return the code in the fragment and REJECT response_mode=query — the
  // request previously failed as "redirect URL not correct".
  it("never sends response_mode", async () => {
    const url = new URL(
      await buildAuthorizeUrl({
        provider: "onedrive",
        clientId: "msft-client",
        redirectUri: REDIRECT,
        scopes: "Files.ReadWrite.AppFolder offline_access User.Read",
        state: "st-2",
        verifier: "v".repeat(43),
      })
    );

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(url.searchParams.get("response_mode")).toBeNull();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st-2");
  });
});

describe("describeMicrosoftAuthorizeError", () => {
  it("maps the Web-platform redemption error to SPA guidance", () => {
    const out = describeMicrosoftAuthorizeError(
      "AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.",
      REDIRECT
    );
    expect(out).toContain("SPA");
    expect(out).toContain(REDIRECT);
  });

  it("maps response_mode rejection to fragment guidance", () => {
    const out = describeMicrosoftAuthorizeError(
      "AADSTS50199: response_mode 'query' is not allowed for this client.",
      REDIRECT
    );
    expect(out).toContain("fragment");
  });

  it("maps an unregistered redirect URI to Azure guidance", () => {
    const out = describeMicrosoftAuthorizeError(
      "AADSTS50011: The redirect URI 'https://app.test/oauth/callback.html' specified in the request does not match.",
      REDIRECT
    );
    expect(out).toContain("Redirect URIs");
  });

  it("passes unknown errors through", () => {
    expect(describeMicrosoftAuthorizeError("something entirely different")).toBeNull();
  });
});

describe("waitForOAuthResult relay gate", () => {
  const TOKENS = { accessToken: "a", refreshToken: "r", expiresIn: 3600, scope: "" };

  it("ignores cross-origin and wrong-state messages, then accepts same-origin delivery", async () => {
    const pending = waitForOAuthResult("st-relay", 5000);
    const stillPending = () =>
      Promise.race([
        pending.then(() => "resolved" as const),
        new Promise((r) => setTimeout(() => r("pending" as const), 25)),
      ]);

    // Cross-origin forgery must be dropped.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        data: { type: "intab-oauth-complete", state: "st-relay", tokens: TOKENS },
      })
    );
    expect(await stillPending()).toBe("pending");

    // Same-origin but wrong state must also be dropped.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: ORIGIN,
        data: { type: "intab-oauth-complete", state: "other", tokens: TOKENS },
      })
    );
    expect(await stillPending()).toBe("pending");

    // The genuine same-origin delivery resolves the wait.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: ORIGIN,
        data: { type: "intab-oauth-complete", state: "st-relay", tokens: TOKENS },
      })
    );
    await expect(pending).resolves.toEqual({ ok: true, tokens: TOKENS });
  });
});

describe("consumeOAuthResult", () => {
  it("rejects a malformed token payload instead of trusting it", () => {
    localStorage.setItem("intab_oauth_result_st-3", JSON.stringify({ ok: true, tokens: {} }));
    const result = consumeOAuthResult("st-3");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("invalid") });
  });
});
