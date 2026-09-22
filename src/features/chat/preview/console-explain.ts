// ============================================================
// Preview Console — Turning One Opaque Warning Into An Answer
// ============================================================
// A console line from a previewed app is usually a fact about the APP. One of
// them is a fact about the harness around it, and it is worth spelling out
// because it repeats on every load and reads like an application bug:
//
//   No routes matched location "srcdoc"
//
// That is react-router telling the truth about a `srcdoc` document. Its URL
// has no hierarchical path, so `location.pathname` is literally "srcdoc" and
// no route can ever match it — the app's first route renders nothing and the
// frame stays empty. Nothing is wrong with the app; the frame it is running in
// cannot host a router at all. Only a real origin can (see ./host, which
// serves the newest build at the origin root for exactly this reason).
//
// Saying so once, in the console, is the difference between a report of "the
// preview is black" and that same report answered.
//
// Pure: a line of output in, an explanation or null out.
// ============================================================

export interface ConsoleExplanationContext {
  /** True when the build is served from a preview host, i.e. a real origin */
  hosted: boolean;
}

export function explainConsoleEntry(
  text: string,
  context: ConsoleExplanationContext
): string | null {
  // With a real origin the app's routes match, so this warning means what it
  // says and is the app's own business.
  if (context.hosted) return null;

  if (/no routes matched location/i.test(text)) {
    return (
      "That warning is about the preview, not the app: this build is running as an inline " +
      'sandboxed document, whose URL path is literally "srcdoc" — a router cannot match any ' +
      "route against it, so the first route renders nothing. The build needs to be served from " +
      "its own origin: the preview host starts with the dev server, so restart `npm run dev` " +
      "if the app was already running when it was added."
    );
  }

  return null;
}
