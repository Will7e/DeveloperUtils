// ============================================================
// HTML Embedding — Safe Interpolation Into Markup
// ============================================================
// Shared by the OAuth popup responders (api/github.ts and the dev
// stub in vite-plugin-api-proxy.ts). Both build an HTML page around
// values derived from the request URL, which is exactly where a
// "<script>" reflection turns into stored XSS on the app origin.
//
// Two rules, both enforced here so neither caller has to remember:
//   1. Never interpolate raw JSON into markup. JSON.stringify leaves
//      `<`, `>` and `&` intact, so `</script>` inside a string ends
//      the element and everything after it is parsed as markup.
//   2. Never interpolate an unvalidated string into an attribute.
// ============================================================

/** Characters that must not survive into an HTML text node */
const HTML_ESCAPES: Array<[RegExp, string]> = [
  [/</g, "\\u003c"],
  [/>/g, "\\u003e"],
  [/&/g, "\\u0026"],
  [/\u2028/g, "\\u2028"],
  [/\u2029/g, "\\u2029"],
];

/**
 * Serializes a value for embedding inside a `<script>` element, including
 * data blocks (`type="application/json"`). The result is valid JSON that
 * cannot terminate the surrounding element or introduce a tag.
 */
export function safeJsonForHtml(value: unknown): string {
  let json = JSON.stringify(value ?? null);
  for (const [pattern, replacement] of HTML_ESCAPES) {
    json = json.replace(pattern, replacement);
  }
  return json;
}

/**
 * Restricts a value to characters that are inert in an HTML attribute
 * context. Used for origins, which are already validated but should never
 * be able to break out of the attribute that carries them.
 */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[^A-Za-z0-9.:/_-]/g, "");
}
