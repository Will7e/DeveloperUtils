// ============================================================
// Web Page — URL Vetting And HTML To Text
// ============================================================
// The agent has to read the web for the same reason it has to read the
// repository: to stop guessing. A dependency's real API, an error message
// nobody has seen before, a spec — all of it lives outside the checkout, and
// a model that cannot reach it will invent a plausible answer instead.
//
// Two jobs, both pure so they can be tested without a network:
//
//   • decide whether a URL may be fetched at all; and
//   • turn a response body into something a model can actually use.
//
// The extraction is deliberately approximate, and it SAYS SO in its own
// output. A crude flattening that pretends to be a faithful rendering is
// worse than an honest one, because the model will confidently reason about
// structure that was never there — a table becomes a wall of words, a nav
// bar becomes content. Nothing here parses HTML properly; it strips what is
// definitely not prose and keeps the rest.
// ============================================================

/** How much page text a tool result carries, before elision */
export const WEB_MAX_TEXT_CHARS = 16_000;
/** Largest response body worth reading at all */
export const WEB_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Whether a URL is something this product is willing to fetch.
 *
 * Only http and https, and never with embedded credentials: `https://user:pass@host`
 * is a way to smuggle a secret into a URL that then gets logged, cached and
 * quoted. Everything else — `file:`, `data:`, `javascript:`, `blob:` — is
 * refused by shape, before any host-level check happens.
 *
 * The host-level checks (loopback, private ranges, cloud metadata) live in
 * utils/ssrfGuard and run in both places that can fetch: the edge function
 * for the proxied path, and the tool itself for the direct one.
 */
export function isBrowsableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (!url.hostname) return false;
  return true;
}

/** The tag whose contents are markup, not prose */
const NON_CONTENT_TAGS = ["script", "style", "noscript", "svg", "template", "iframe", "head"];

/** Blocks that end a line once their text is emitted */
const BLOCK_TAGS =
  "p|div|section|article|header|footer|main|aside|nav|ul|ol|table|thead|tbody|tr|form|fieldset|figure|figcaption|blockquote|pre|hr|h[1-6]";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decodes the named and numeric entities that actually show up in prose */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body.startsWith("#x") || body.startsWith("#X");
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** The page's title, from `<title>` or the og:title fallback */
export function extractTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title) {
    const clean = decodeEntities(title).replace(/\s+/g, " ").trim();
    if (clean) return clean.slice(0, 200);
  }
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
  return og ? decodeEntities(og).replace(/\s+/g, " ").trim().slice(0, 200) : null;
}

/**
 * HTML to text, for reading rather than rendering.
 *
 * Order matters: script and style content is removed BEFORE tags are
 * stripped, because the alternative is shipping minified JavaScript into a
 * context window as if it were prose — which is both expensive and a
 * famously good way to make a model hallucinate.
 */
export function htmlToText(html: string): string {
  let text = html;

  // Metadata that is neither prose nor structure.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of NON_CONTENT_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    // An unclosed one (common in malformed pages) still has to go.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
  }

  // Links keep their label; the URL is noise the model rarely needs inline,
  // and absolute links are usually navigation.
  text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Headings BEFORE the block pass, which would otherwise rewrite <h1> to a
  // bare newline and lose the level that makes a section readable.
  text = text.replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${"#".repeat(Number(level))} `);
  text = text.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
  text = text.replace(new RegExp(`<\\/(?:${BLOCK_TAGS})>`, "gi"), "\n");

  // Whatever is left is a tag: attributes and all. Replaced with a space so
  // `</b><i>` cannot weld two words together, then the space it introduced in
  // front of punctuation is taken back — `Hello <b>world</b>.` must not read
  // as `Hello world .`.
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[ \t\f\v\u00a0]+/g, " ");
  text = text.replace(/ +([.,;:!?)\]}%])/g, "$1");
  text = text.replace(/([([{]) +/g, "$1");
  text = text.replace(/ *\n[ \t]*/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export interface WebExtraction {
  /** What was read, described honestly */
  kind: "html" | "text" | "json" | "unsupported";
  title: string | null;
  text: string;
  truncated: boolean;
  /** One line the caller can put in the tool result, including caveats */
  note: string;
}

/**
 * A response body as something worth reading, with its own caveats attached.
 *
 * Binary content is refused rather than mangled: a PDF's bytes or a PNG's
 * pixels decoded as text is how a model comes to describe a document that
 * does not exist.
 */
export function flattenWebBody(body: string, contentType: string, maxChars = WEB_MAX_TEXT_CHARS): WebExtraction {
  const type = contentType.toLowerCase();
  const isHtml = type.includes("html") || /^\s*<(!doctype|html|head|body)\b/i.test(body);
  const isJson = type.includes("json");
  const isTextLike = type.startsWith("text/") || type.includes("xml") || isJson;

  if (!isHtml && !isTextLike) {
    return {
      kind: "unsupported",
      title: null,
      text: "",
      truncated: false,
      note: `This URL returned ${contentType || "an unknown content type"}, which is not text — nothing was read from it. Fetch an HTML or text document instead.`,
    };
  }

  const source = isHtml ? htmlToText(body) : body.trim();
  const title = isHtml ? extractTitle(body) : null;
  const shaped = elide(source, maxChars);

  if (isHtml) {
    return {
      kind: "html",
      title,
      text: shaped.text,
      truncated: shaped.truncated,
      note:
        "Extracted from HTML by stripping markup, so the structure is APPROXIMATE: tables, layout and interactive content are flattened, and navigation or boilerplate may be interleaved with the prose. Treat this as the page's words, not as a faithful rendering.",
    };
  }
  return {
    kind: isJson ? "json" : "text",
    title,
    text: shaped.text,
    truncated: shaped.truncated,
    note: `Returned as ${isJson ? "JSON" : "plain text"} with no markup removal.`,
  };
}

/** Keeps the head and the tail, and says how much went missing */
export function elide(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = text.slice(0, Math.floor(maxChars * 0.75));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.25));
  const omitted = text.length - maxChars;
  return {
    text: `${head}\n\n… ${omitted} characters elided …\n\n${tail}`,
    truncated: true,
  };
}

/**
 * The URL a reader should be told about after redirects.
 *
 * Worth surfacing: a short link that lands somewhere unexpected is the
 * cheapest signal that a fetch went somewhere the user did not intend, and
 * the model can see it without asking.
 */
export function describeRedirect(requested: string, finalUrl: string): string | null {
  const normalized = (value: string) => value.replace(/\/+$/, "");
  return normalized(requested) === normalized(finalUrl) ? null : `Redirected to ${finalUrl}`;
}
