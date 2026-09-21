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
// Requires (Vercel env vars — NEVER prefix with VITE_):
//   GITHUB_CLIENT_ID
//   GITHUB_CLIENT_SECRET

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

function htmlPage(body: string, origin: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Connecting GitHub…</title></head>
  <body>
    <script>
      (function () {
        var payload = ${body};
        if (window.opener) {
          window.opener.postMessage(
            { source: "intab-github-oauth", payload: payload },
            ${JSON.stringify(origin)}
          );
        }
        setTimeout(function () { window.close(); }, 150);
      })();
    </script>
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
      },
    }
  );
}

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") || new URL(req.url).origin;
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }

  const clientId =
    process.env.GITHUB_CLIENT_ID ||
    (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ||
    "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || "";

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const errorParam = url.searchParams.get("error");

  // ── Error path: user denied or GitHub errored ──
  if (errorParam) {
    return htmlPage(
      JSON.stringify({ ok: false, error: url.searchParams.get("error_description") || errorParam }),
      origin
    );
  }

  if (!clientId || !clientSecret) {
    return htmlPage(
      JSON.stringify({
        ok: false,
        error: "GitHub sign-in is not configured on the server (missing GITHUB_CLIENT_ID/SECRET).",
      }),
      origin
    );
  }

  if (!code) {
    return htmlPage(JSON.stringify({ ok: false, error: "Missing ?code parameter." }), origin);
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
        JSON.stringify({
          ok: false,
          error: data.error_description || data.error || `Token exchange failed (HTTP ${tokenRes.status}).`,
        }),
        origin
      );
    }

    return htmlPage(JSON.stringify({ ok: true, accessToken: data.access_token }), origin);
  } catch (err) {
    return htmlPage(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : "Token exchange failed.",
      }),
      origin
    );
  }
}
