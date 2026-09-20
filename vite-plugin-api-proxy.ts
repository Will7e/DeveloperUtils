import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { validateUrlForSSRF } from "./src/utils/ssrfGuard";

/**
 * Hop-by-hop headers that should not be forwarded to the upstream server.
 */
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
 * Check if the request Origin is an authorized local development origin.
 * Blocks malicious third-party websites from making drive-by requests to localhost.
 */
function isAllowedDevOrigin(originStr?: string): boolean {
  if (!originStr) return true; // Direct same-origin or tool execution without Origin header
  try {
    const o = new URL(originStr);
    return (
      o.hostname === "localhost" ||
      o.hostname === "127.0.0.1" ||
      o.hostname.endsWith(".localhost") ||
      o.hostname === "0.0.0.0" ||
      o.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Vite plugin that intercepts requests to `/api/proxy` and proxies them
 * using Node.js native `fetch`. Eliminates CORS restrictions for developer
 * tools while enforcing strict origin validation and SSRF metadata blocking.
 */
export function apiProxyPlugin(): Plugin {
  return {
    name: "vite-plugin-api-proxy",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        // ── Dev stub for the license edge function ──
        // In production /api/license runs as a Vercel edge function. In dev
        // there is no server route, so without this stub the SPA fallback
        // would answer with index.html and license activation would fail
        // with a confusing parse error. Behavior mirrors api/license.ts:
        // any well-formed key is accepted; LEMON_SQUEEZY_TEST_KEY forces a
        // rejection so the failure path can be tested too.
        if (req.url?.startsWith("/api/license")) {
          const origin = (req.headers["origin"] as string) || "";
          const allowedOrigin = isAllowedDevOrigin(origin) ? origin || "http://localhost:5173" : "";
          res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "*");

          if (req.method === "OPTIONS") {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ valid: false, error: "Method not allowed" }));
            return;
          }

          let bodyRaw = "";
          req.on("data", (chunk) => (bodyRaw += chunk));
          req.on("end", () => {
            try {
              const body = JSON.parse(bodyRaw || "{}") as { licenseKey?: string };
              const key = (body.licenseKey || "").trim();
              if (!key) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ valid: false, error: "Missing licenseKey" }));
                return;
              }
              if (key === "LEMON_SQUEEZY_TEST_KEY") {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ valid: false, error: "License is not valid (test rejection key)" }));
                return;
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ valid: true, expiresAt: null }));
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ valid: false, error: "Invalid JSON body" }));
            }
          });
          return;
        }

        if (!req.url?.startsWith("/api/proxy")) {
          return next();
        }

        const origin = (req.headers["origin"] as string) || "";
        const allowedOrigin = isAllowedDevOrigin(origin) ? (origin || "http://localhost:5173") : "";

        // Reject drive-by attacks from foreign origins
        if (origin && !isAllowedDevOrigin(origin)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: `Forbidden cross-origin request from untrusted origin: '${origin}'`,
              code: "CROSS_ORIGIN_FORBIDDEN",
            })
          );
          return;
        }

        // Handle preflight OPTIONS request
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Expose-Headers", "*");
        res.setHeader("Access-Control-Max-Age", "86400");

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        try {
          const parsedUrl = new URL(req.url, "http://localhost");
          const targetUrl = parsedUrl.searchParams.get("url") || (req.headers["x-target-url"] as string);

          if (!targetUrl) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing 'url' query parameter or 'x-target-url' header" }));
            return;
          }

          // SSRF Guard: Validate target against cloud metadata endpoints
          const ssrfCheck = validateUrlForSSRF(targetUrl, {
            allowLocalhost: true, // Allow local development endpoints
            allowPrivateSubnets: true, // Allow intranet endpoints in local dev
          });

          if (!ssrfCheck.allowed || !ssrfCheck.normalizedUrl) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: `Forbidden target URL: ${ssrfCheck.reason || "Blocked by SSRF policy"}`,
                code: "SSRF_BLOCKED",
              })
            );
            return;
          }

          const validUrl = new URL(ssrfCheck.normalizedUrl);

          // Read incoming body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          const bodyBuffer = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

          // Assemble upstream headers
          const forwardHeaders: Record<string, string> = {};

          // 1. Copy incoming headers (excluding hop-by-hop & proxy-specific)
          for (const [key, val] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (
              !HOP_BY_HOP_HEADERS.has(lower) &&
              lower !== "x-target-url" &&
              lower !== "x-proxy-headers" &&
              typeof val === "string"
            ) {
              forwardHeaders[key] = val;
            }
          }

          // 2. Unpack explicit custom headers from `x-proxy-headers`
          // (Allows client to supply browser-forbidden headers like User-Agent, Cookie, etc.)
          const rawProxyHeaders = req.headers["x-proxy-headers"];
          if (typeof rawProxyHeaders === "string" && rawProxyHeaders.trim()) {
            try {
              const customHeaders = JSON.parse(decodeURIComponent(rawProxyHeaders));
              if (customHeaders && typeof customHeaders === "object") {
                for (const [k, v] of Object.entries(customHeaders)) {
                  if (typeof v === "string" && k.trim()) {
                    forwardHeaders[k.trim()] = v;
                  }
                }
              }
            } catch {
              // Ignore JSON parse errors in custom headers
            }
          }

          // Set host header to target host
          forwardHeaders["host"] = validUrl.host;

          // Perform upstream fetch via Node.js with safe redirect loop
          let currentMethod = (req.method || "GET").toUpperCase();
          const canHaveBody = currentMethod !== "GET" && currentMethod !== "HEAD";
          const initialBody = canHaveBody && bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : undefined;

          const MAX_REDIRECTS = 3;
          let upstreamRes: Response | null = null;
          let activeTargetUrl = validUrl;

          for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            upstreamRes = await fetch(activeTargetUrl.toString(), {
              method: hop === 0 ? currentMethod : (upstreamRes?.status === 303 ? "GET" : currentMethod),
              headers: forwardHeaders,
              body: hop === 0 ? initialBody : undefined,
              redirect: "manual",
            });

            if ([301, 302, 303, 307, 308].includes(upstreamRes.status)) {
              const location = upstreamRes.headers.get("location");
              if (!location) break;

              const resolvedRedirectUrl = new URL(location, activeTargetUrl).toString();
              const redirectCheck = validateUrlForSSRF(resolvedRedirectUrl, {
                allowLocalhost: true,
                allowPrivateSubnets: true,
              });

              if (!redirectCheck.allowed || !redirectCheck.normalizedUrl) {
                res.statusCode = 403;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: `SSRF Blocked: Redirect target prohibited: ${redirectCheck.reason || "Forbidden redirect target"}`,
                    code: "SSRF_REDIRECT_BLOCKED",
                  })
                );
                return;
              }

              activeTargetUrl = new URL(redirectCheck.normalizedUrl);
              forwardHeaders["host"] = activeTargetUrl.host;
              if (upstreamRes.status === 303) {
                currentMethod = "GET";
              }
              continue;
            }

            break;
          }

          if (!upstreamRes) {
            throw new Error("No response from target server");
          }

          // Forward response status
          res.statusCode = upstreamRes.status;
          res.statusMessage = upstreamRes.statusText;

          // Forward response headers (excluding encoding/length headers handled by Node fetch)
          upstreamRes.headers.forEach((val, key) => {
            const lower = key.toLowerCase();
            if (
              lower !== "content-encoding" &&
              lower !== "content-length" &&
              lower !== "transfer-encoding" &&
              lower !== "access-control-allow-origin" &&
              lower !== "access-control-expose-headers"
            ) {
              res.setHeader(key, val);
            }
          });

          // Stream body to client
          if (upstreamRes.body) {
            const reader = upstreamRes.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } finally {
              reader.releaseLock();
            }
          }

          res.end();
        } catch (err: unknown) {
          const error = err as Error & { code?: string };
          console.error("[API Proxy Error]:", error.message);

          if (!res.headersSent) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: `Proxy request failed: ${error.message}`,
                code: error.code || "PROXY_GATEWAY_ERROR",
              })
            );
          } else {
            res.end();
          }
        }
      });
    },
  };
}
