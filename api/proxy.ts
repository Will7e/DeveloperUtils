import { validateUrlForSSRF } from "../src/utils/ssrfGuard";

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

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") || "*";

  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
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
          "Access-Control-Allow-Origin": origin,
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
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Expose-Headers": "*",
          },
        }
      );
    }

    const validUrl = new URL(ssrfCheck.normalizedUrl);

    // Assemble headers
    const forwardHeaders = new Headers();
    req.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== "x-target-url" && lower !== "x-proxy-headers") {
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

    const method = req.method.toUpperCase();
    const canHaveBody = method !== "GET" && method !== "HEAD";
    const body = canHaveBody ? req.body : undefined;

    const upstreamRes = await fetch(validUrl.toString(), {
      method,
      headers: forwardHeaders,
      body,
      redirect: "follow",
    });

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

    resHeaders.set("Access-Control-Allow-Origin", origin);
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
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Expose-Headers": "*",
        },
      }
    );
  }
}
