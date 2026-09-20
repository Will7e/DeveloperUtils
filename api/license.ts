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

  const apiKey = import.meta.env.LEMON_SQUEEZY_API_KEY as string | undefined;
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
