// ============================================================
// GitHub Edge Function — OAuth Code Exchange
// ============================================================
// GET /api/github?code=...  (redirect_uri target of the OAuth popup)
//
// Exchanges the authorization code for an access token using
// GITHUB_CLIENT_SECRET (server-side only). Responds with a tiny
// HTML page that postMessages the token to the opener and closes
// itself. The token transits server→popup page→opener over TLS
// and is then stored client-side (encrypted at rest, like the
// OpenRouter key).
//
// The response page never interpolates untrusted text into markup
// or into a <script> body: the payload is embedded in a
// <script type="application/json"> data block with HTML-significant
// characters escaped, and the logic lives in an external file
// (/oauth/github-popup.js). That keeps the page safe under a strict
// default-src 'none' policy and immune to the "error_description
// closes the script element" XSS class.
//
// Requires (Vercel env vars — NEVER prefix with VITE_):
//   GITHUB_CLIENT_ID
//   GITHUB_CLIENT_SECRET

import { escapeHtmlAttribute, safeJsonForHtml } from "../src/utils/htmlEmbed.js";

export const config = {
  runtime: "edge",
};

/** Origins allowed to open the popup / receive the token postMessage */
function isAllowedOrigin(originStr: string | null): boolean {
  if (!originStr) return true;
  try {
    const o = new URL(originStr);
    const host = o.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localhost") ||
      host === "in-tab.se" ||
      host.endsWith(".in-tab.se") ||
      host === "intab.dev" ||
      host.endsWith(".intab.dev") ||
      host === process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      host === process.env.VERCEL_URL ||
      (host.endsWith(".vercel.app") && process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? host.endsWith(
            "." + String(process.env.VERCEL_PROJECT_PRODUCTION_URL).replace(/^www\./, "")
          )
        : false)
    );
  } catch {
    return false;
  }
}

function htmlPage(payload: unknown, origin: string): Response {
  const targetOrigin = escapeHtmlAttribute(origin);
  return new Response(
    `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Connecting GitHub…</title>
  </head>
  <body>
    <script id="intab-oauth-payload" type="application/json">${safeJsonForHtml(payload)}</script>
    <script src="/oauth/github-popup.js" data-target-origin="${targetOrigin}"></script>
    <p style="font-family: system-ui; color: #555;">Completing GitHub sign-in…</p>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // The page runs in a popup opened by the app; it needs no CORS.
        "X-Content-Type-Options": "nosniff",
        // Defence in depth: this popup needs no network, no images and no
        // inline script. Nothing here can be reached by an injected string.
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      },
    }
  );
}

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") || new URL(req.url).origin;
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }

  // Server-only config. `import.meta.env` is a Vite (client) construct and is
  // not populated by the edge runtime, so reading it here would throw.
  const clientId = process.env.GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || "";

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const errorParam = url.searchParams.get("error");

  // ── Error path: user denied or GitHub errored ──
  if (errorParam) {
    return htmlPage(
      {
        ok: false,
        state,
        error: url.searchParams.get("error_description") || errorParam,
      },
      origin
    );
  }

  if (!clientId || !clientSecret) {
    return htmlPage(
      {
        ok: false,
        state,
        error: "GitHub sign-in is not configured on the server (missing GITHUB_CLIENT_ID/SECRET).",
      },
      origin
    );
  }

  if (!code) {
    return htmlPage({ ok: false, state, error: "Missing ?code parameter." }, origin);
  }

  // ── Exchange the code for an access token ──
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        // GitHub requires this to match the authorize redirect_uri exactly
        redirect_uri: `${origin}/api/github`,
        state,
      }),
    });

    const data = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || data.error || !data.access_token) {
      return htmlPage(
        {
          ok: false,
          state,
          error:
            data.error_description ||
            data.error ||
            `Token exchange failed (HTTP ${tokenRes.status}).`,
        },
        origin
      );
    }

    return htmlPage({ ok: true, state, accessToken: data.access_token }, origin);
  } catch (err) {
    return htmlPage(
      {
        ok: false,
        state,
        error: err instanceof Error ? err.message : "Token exchange failed.",
      },
      origin
    );
  }
}
