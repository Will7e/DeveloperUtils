// ============================================================
// Sanitize Utilities — Input sanitization & security helpers
// ============================================================

/**
 * Escapes unsafe HTML characters to prevent XSS attacks.
 * Use whenever user-supplied strings are rendered or interpolated into markup.
 */
export function sanitizeHtml(str: string): string {
  if (!str) return "";
  const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
    "`": "&#x60;",
  };
  return str.replace(/[&<>"'`/]/g, (char) => htmlEscapes[char] || char);
}

/**
 * Validates that a string is a legitimate HTTP, HTTPS, WS, or WSS URL.
 * Rejects dangerous protocols like javascript:, data:, vbscript:, file:, etc.
 */
export function isValidProtocol(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== "string") return false;
  const trimmed = urlStr.trim().toLowerCase();
  // Reject obvious dangerous protocol strings
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return false;
  }
  // Allow relative URLs starting with /
  if (trimmed.startsWith("/")) {
    return true;
  }
  // Allow template variables like {{baseUrl}}/api
  if (trimmed.startsWith("{{") || trimmed.includes("{{")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol);
  } catch {
    // Might be a host without protocol (e.g. "api.example.com/v1")
    return !/^[a-z0-9+.-]+:/i.test(trimmed) || /^(http|https|ws|wss):\/\//i.test(trimmed);
  }
}

/**
 * Sanitizes and normalizes a target URL, returning a safe fallback if invalid.
 */
export function sanitizeUrl(urlStr: string, fallback = ""): string {
  if (!isValidProtocol(urlStr)) {
    return fallback;
  }
  return urlStr.trim();
}

/**
 * Masks sensitive tokens, passwords, and secrets for safe UI display.
 * E.g., "ghp_1234567890abcdef" -> "ghp_••••••••cdef"
 */
export function maskSecret(secret: string, visibleEndChars = 4): string {
  if (!secret || typeof secret !== "string") return "";
  const trimmed = secret.trim();
  if (trimmed.length <= visibleEndChars * 2) {
    return "••••••••";
  }
  const maskedLength = Math.min(8, trimmed.length - visibleEndChars);
  const mask = "•".repeat(maskedLength);
  const visible = trimmed.slice(-visibleEndChars);
  return `${mask}${visible}`;
}

/**
 * Redacts values of sensitive HTTP headers (Authorization, X-API-Key, etc.)
 */
export function redactHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase().trim();
  const sensitiveHeaderNames = [
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
    "api-key",
    "apikey",
    "secret",
    "cookie",
    "set-cookie",
  ];
  if (sensitiveHeaderNames.includes(lower)) {
    return "••••••";
  }
  return value;
}
