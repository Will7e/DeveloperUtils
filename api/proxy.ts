import { validateUrlForSSRF } from "../src/utils/ssrfGuard.js";

export const config = {
  runtime: "edge",
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/**
 * Headers never copied from the *incoming* request to the upstream target.
 * `cookie` is included because the browser attaches this origin's cookies to
 * same-origin requests, and relaying them to an arbitrary third-party host
 * would leak them. A client that genuinely wants to send a Cookie header can
 * still do so explicitly through `x-proxy-headers` (that path is applied
 * after this filter), which is exactly how the API tester sends one.
 */
const NEVER_FORWARDED_HEADERS = new Set(["cookie"]);

/**
 * Best-effort fixed-window throttle. This endpoint is a public relay: it
 * blocks private/metadata targets, but without a limit it is still free
 * bandwidth and a useful anonymizer for anyone with a script. Per-isolate
 * and deliberately generous — real client usage is bursty.
 */
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_REQUESTS = 200;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function withinRateLimit(key: string): boolean {
  const now = Date.now();

  if (rateBuckets.size > 5_000) {
    for (const [k, v] of rateBuckets) {
      if (v.resetAt <= now) rateBuckets.delete(k);
    }
    if (rateBuckets.size > 5_000) rateBuckets.clear();
  }

  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * Checks if the incoming request Origin is an authorized InTab origin.
 * Prevents third-party malicious sites from abusing InTab as an open anonymous proxy.
 *
 * A missing Origin header is allowed on purpose: browsers omit it on
 * same-origin GET/HEAD requests, which the app itself makes (GitHub and
 * OpenRouter reads fall back to this proxy), and non-browser clients are
 * indistinguishable from those. The SSRF guard plus the rate limit bound
 * what an Origin-less caller can do; a shared secret would be the next step
 * if the relay ever needs to be closed completely.
 */
function isAllowedOrigin(originStr: string | null): boolean {
  if (!originStr) return true; // Direct same-origin request (no Origin header)
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
      // Preview deployments: any <project>.vercel.app subdomain of this app
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
  const origin = req.headers.get("origin");

  // Enforce origin validation to prevent open relay abuse
  if (origin && !isAllowedOrigin(origin)) {
    return new Response(
      JSON.stringify({
        error: `Forbidden cross-origin proxy request: Origin '${origin}' is not authorized.`,
        code: "CROSS_ORIGIN_FORBIDDEN",
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const allowedOriginHeader = origin || "*";

  // Throttle before doing any work: this endpoint is an open relay for
  // Origin-less callers (see isAllowedOrigin).
  if (!withinRateLimit(clientKey(req))) {
    return new Response(
      JSON.stringify({ error: "Too many proxy requests — slow down.", code: "RATE_LIMITED" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOriginHeader,
          "Retry-After": "10",
        },
      }
    );
  }

  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOriginHeader,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Expose-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    const url = new URL(req.url);
    const targetUrl = url.searchParams.get("url") || req.headers.get("x-target-url");

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "Missing 'url' query parameter" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOriginHeader,
          "Access-Control-Expose-Headers": "*",
        },
      });
    }

    // SSRF Guard: Validate target against cloud metadata, loopback, and private IP subnets
    const ssrfCheck = validateUrlForSSRF(targetUrl, {
      allowLocalhost: false,
      allowPrivateSubnets: false,
    });

    if (!ssrfCheck.allowed || !ssrfCheck.normalizedUrl) {
      return new Response(
        JSON.stringify({
          error: `Forbidden target URL: ${ssrfCheck.reason || "Blocked by SSRF protection policy"}`,
          code: "SSRF_BLOCKED",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": allowedOriginHeader,
            "Access-Control-Expose-Headers": "*",
          },
        }
      );
    }

    let validUrl = new URL(ssrfCheck.normalizedUrl);

    // Assemble headers
    const forwardHeaders = new Headers();
    req.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (
        !HOP_BY_HOP_HEADERS.has(lower) &&
        !NEVER_FORWARDED_HEADERS.has(lower) &&
        lower !== "x-target-url" &&
        lower !== "x-proxy-headers"
      ) {
        forwardHeaders.set(key, val);
      }
    });

    const rawProxyHeaders = req.headers.get("x-proxy-headers");
    if (rawProxyHeaders) {
      try {
        const custom = JSON.parse(decodeURIComponent(rawProxyHeaders));
        if (custom && typeof custom === "object") {
          for (const [k, v] of Object.entries(custom)) {
            if (typeof v === "string" && k.trim()) {
              forwardHeaders.set(k.trim(), v);
            }
          }
        }
      } catch {
        // Ignore JSON errors
      }
    }

    forwardHeaders.set("host", validUrl.host);

    let method = req.method.toUpperCase();
    const canHaveBody = method !== "GET" && method !== "HEAD";
    const body = canHaveBody ? req.body : undefined;

    // Safe Redirect Loop: Prevent SSRF bypass via 301/302/307/308 redirects to cloud metadata
    const MAX_REDIRECTS = 3;
    let upstreamRes: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      upstreamRes = await fetch(validUrl.toString(), {
        method: hop === 0 ? method : (upstreamRes?.status === 303 ? "GET" : method),
        headers: forwardHeaders,
        body: hop === 0 ? body : undefined,
        redirect: "manual",
      });

      if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
        const location = upstreamRes.headers.get("location");
        if (!location) break;

        const resolvedRedirectUrl = new URL(location, validUrl).toString();
        const redirectCheck = validateUrlForSSRF(resolvedRedirectUrl, {
          allowLocalhost: false,
          allowPrivateSubnets: false,
        });

        if (!redirectCheck.allowed || !redirectCheck.normalizedUrl) {
          return new Response(
            JSON.stringify({
              error: `SSRF Blocked: Redirect target prohibited: ${redirectCheck.reason || "Forbidden redirect target"}`,
              code: "SSRF_REDIRECT_BLOCKED",
            }),
            {
              status: 403,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": allowedOriginHeader,
              },
            }
          );
        }

        validUrl = new URL(redirectCheck.normalizedUrl);
        forwardHeaders.set("host", validUrl.host);
        if (upstreamRes.status === 303) {
          method = "GET";
        }
        continue;
      }

      break;
    }

    if (!upstreamRes) {
      throw new Error("No response received from target");
    }

    const resHeaders = new Headers();
    upstreamRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (
        lower !== "content-encoding" &&
        lower !== "content-length" &&
        lower !== "transfer-encoding" &&
        lower !== "access-control-allow-origin" &&
        lower !== "access-control-expose-headers"
      ) {
        resHeaders.set(key, val);
      }
    });

    resHeaders.set("Access-Control-Allow-Origin", allowedOriginHeader);
    resHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS");
    resHeaders.set("Access-Control-Allow-Headers", "*");
    resHeaders.set("Access-Control-Expose-Headers", "*");

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    const error = err as Error;
    return new Response(
      JSON.stringify({ error: `Proxy request failed: ${error.message}`, code: "PROXY_GATEWAY_ERROR" }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOriginHeader,
          "Access-Control-Expose-Headers": "*",
        },
      }
    );
  }
}
