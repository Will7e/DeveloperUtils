// ============================================================
// OAuth Token Exchange — server-side completion for cloud sync
// ============================================================
// POST /api/oauth-exchange  { provider, code, codeVerifier }
//
// Google's OAuth client is a "Web application", so the token
// endpoint requires client_secret on the authorization-code exchange
// — a value that must never ship in the browser bundle. The popup's
// callback page (public/oauth/callback.js) holds the PKCE verifier
// from the opener's handoff and posts the code here; this function
// adds the secret, performs the exchange, and returns the tokens.
// The secret transits TLS from server to popup page only; it is
// never embedded in any page.
//
// Microsoft is proxied through the same endpoint for symmetry: its
// redirect URI is registered as platform SPA, so no secret exists or
// is needed — this endpoint simply forwards the browser-side exchange.
//
// Requires (Vercel env vars — NEVER prefix the secret with VITE_):
//   GOOGLE_CLIENT_ID       (falls back to VITE_GOOGLE_CLIENT_ID)
//   GOOGLE_CLIENT_SECRET   (falls back to VITE_GOOGLE_SECRET)
//   MSFT_CLIENT_ID         (falls back to VITE_MSFT_CLIENT_ID)

export const config = {
  runtime: "edge",
};

interface ExchangeBody {
  provider?: unknown;
  code?: unknown;
  codeVerifier?: unknown;
  redirectUri?: unknown;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Same-origin discipline: only pages served by this app may exchange. */
function isAllowedOrigin(originStr: string | null): boolean {
  if (!originStr) return true;
  try {
    const host = new URL(originStr).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".localhost") ||
      host === "in-tab.se" ||
      host.endsWith(".in-tab.se") ||
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

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") || new URL(req.url).origin;
  if (!isAllowedOrigin(origin)) {
    return json({ ok: false, error: "Forbidden origin." }, 403);
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  let body: ExchangeBody;
  try {
    body = (await req.json()) as ExchangeBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const provider = body.provider === "googledrive" ? "googledrive" : body.provider === "onedrive" ? "onedrive" : null;
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";

  if (!provider || !code || !codeVerifier) {
    return json(
      { ok: false, error: "Missing provider, code, or codeVerifier." },
      400
    );
  }

  // The redirect_uri must match the authorize request exactly; derive it
  // from the validated Origin rather than trusting the body.
  const redirectUri = `${origin}/oauth/callback.html`;

  const isGoogle = provider === "googledrive";
  const clientId = isGoogle
    ? process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || ""
    : process.env.MSFT_CLIENT_ID || process.env.VITE_MSFT_CLIENT_ID || "";
  // The secret exists only for the Google Web-application client. The
  // VITE_-prefixed fallback keeps existing deploys working; a clean setup
  // sets GOOGLE_CLIENT_SECRET (server-side, unprefixed).
  const clientSecret = isGoogle
    ? process.env.GOOGLE_CLIENT_SECRET || process.env.VITE_GOOGLE_SECRET || ""
    : "";

  if (!clientId) {
    return json(
      {
        ok: false,
        error: isGoogle
          ? "Google Drive sign-in is not configured on the server (missing GOOGLE_CLIENT_ID)."
          : "OneDrive sign-in is not configured on the server (missing MSFT_CLIENT_ID).",
      },
      500
    );
  }
  if (isGoogle && !clientSecret) {
    return json(
      {
        ok: false,
        error:
          "Google token exchange is not configured on the server (missing GOOGLE_CLIENT_SECRET). Set it in Vercel environment variables.",
      },
      500
    );
  }

  const form = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (clientSecret) form.set("client_secret", clientSecret);

  const tokenUrl = isGoogle
    ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/token";

  try {
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });

    const data = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok || !data.access_token) {
      return json(
        {
          ok: false,
          error:
            data.error_description ||
            data.error ||
            `Token exchange failed (HTTP ${tokenRes.status}).`,
        },
        502
      );
    }

    return json({
      ok: true,
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? null,
        expiresIn: data.expires_in ?? 3600,
        scope: data.scope ?? "",
      },
    });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Token exchange network error.",
      },
      502
    );
  }
}
