// ============================================================
// License Edge Function — Lemon Squeezy Validation
// ============================================================
// POST /api/license  { licenseKey: string, instanceName?: string }
// → { valid, expiresAt, error? }
//
// Activates (first call) and validates (subsequent calls) a license
// key against the Lemon Squeezy API. The store API key never leaves
// the server. Requires LEMON_SQUEEZY_API_KEY as an environment
// variable (server-side only — do NOT prefix with VITE_).

export const config = {
  runtime: "edge",
};

const LS_API_BASE = "https://api.lemonsqueezy.com/v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Max license entries held per edge isolate (keys are caller-supplied) */
const CACHE_MAX_ENTRIES = 500;
/** Best-effort per-isolate throttle: requests allowed per window per client */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

/**
 * Origins allowed to call this endpoint. It is POST-only and same-origin
 * from the app, so an allowlist costs nothing and keeps the endpoint from
 * being used as a validation oracle by third-party pages.
 */
function isAllowedOrigin(originStr: string | null): boolean {
  if (!originStr) return true; // Non-browser client (no Origin header)
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

/** Best-effort fixed-window throttle (per edge isolate, not global) */
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

interface LsLicense {
  id: number;
  status: string;
  key: string;
  activation_limit: number | null;
  activation_usage: number | null;
  expires_at: string | null;
}

interface LsMeta {
  valid: boolean;
  error?: string | null;
  license_key?: LsLicense;
  instance?: { id: string; name: string } | null;
}

// Simple in-memory validation cache (per edge isolate)
const cache = new Map<string, { result: LsMeta; at: number }>();

async function callLemonSqueezy(
  apiKey: string,
  body: Record<string, unknown>,
  activate: boolean
): Promise<LsMeta> {
  const res = await fetch(`${LS_API_BASE}/licenses/${activate ? "activate" : "validate"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as LsMeta & { error?: string };
  if (!res.ok) {
    return {
      valid: false,
      error: json.error || `Lemon Squeezy error (${res.status})`,
    };
  }
  return json;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ valid: false, error: "Method not allowed" }, 405);
  }

  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return json({ valid: false, error: "Forbidden origin" }, 403);
  }

  if (!withinRateLimit(clientKey(req))) {
    return json({ valid: false, error: "Too many license checks — try again shortly." }, 429);
  }

  // Server-only env var. This runs on the Vercel edge runtime, where
  // `process.env` is the supported interface; `import.meta.env` is a Vite
  // construct that is never populated here.
  const apiKey = process.env.LEMON_SQUEEZY_API_KEY;
  if (!apiKey) {
    return json({ valid: false, error: "License service not configured" }, 503);
  }

  let body: { licenseKey?: string; instanceName?: string };
  try {
    body = (await req.json()) as { licenseKey?: string; instanceName?: string };
  } catch {
    return json({ valid: false, error: "Invalid JSON body" }, 400);
  }

  const licenseKey = body.licenseKey?.trim();
  if (!licenseKey) {
    return json({ valid: false, error: "Missing licenseKey" }, 400);
  }

  // Cache lookup (validation only — activation always hits the API)
  const cached = cache.get(licenseKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    const c = cached.result;
    if (c.valid) {
      return json({
        valid: true,
        expiresAt: c.license_key?.expires_at ? new Date(c.license_key.expires_at).getTime() : null,
      });
    }
  }

  try {
    // Step 1: validate the key
    let meta = await callLemonSqueezy(apiKey, { license_key: licenseKey }, false);

    // Step 2: activate when valid but not yet activated for this deployment
    if (meta.valid && !meta.instance?.id) {
      meta = await callLemonSqueezy(
        apiKey,
        { license_key: licenseKey, instance_name: body.instanceName || "InTab App" },
        true
      );
      // Activation may fail if the key hit its activation limit but is
      // still valid for this instance — validation result stays authoritative.
      if (!meta.valid && meta.error?.includes("activation")) {
        meta = await callLemonSqueezy(apiKey, { license_key: licenseKey }, false);
      }
    }

    // Bounded cache: the key comes from the caller, so an unbounded map is a
    // memory-growth vector inside a warm isolate.
    if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(licenseKey)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(licenseKey, { result: meta, at: Date.now() });

    if (!meta.valid) {
      return json({ valid: false, error: meta.error || "License is not valid" }, 200);
    }

    return json({
      valid: true,
      expiresAt: meta.license_key?.expires_at
        ? new Date(meta.license_key.expires_at).getTime()
        : null,
    });
  } catch (err) {
    return json(
      { valid: false, error: err instanceof Error ? err.message : "License check failed" },
      502
    );
  }
}
