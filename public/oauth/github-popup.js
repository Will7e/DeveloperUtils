// ============================================================
// GitHub OAuth popup relay
// ============================================================
// Loaded by /api/github (and by the dev-server stub in
// vite-plugin-api-proxy.ts) inside the OAuth popup window. The
// payload travels in a <script type="application/json"> data block
// so untrusted text never reaches markup or executable script.
//
// Kept as an external file on purpose: it lets the wrapping page use
// a strict `default-src 'none'; script-src 'self'` policy with no
// 'unsafe-inline', which is what makes the page immune to injected
// script elements.
//
// TWO CHANNELS, because the opener is not always there. The app is served with
// `Cross-Origin-Opener-Policy: same-origin` (the only value that gives the
// browser workspace its cross-origin isolation), and that puts this popup in its
// own browsing context group once it navigates to github.com — after which
// `window.opener` is null even though the page is back on our own origin. A
// BroadcastChannel is per-origin rather than per-group, so it reaches the app
// either way; the postMessage path is kept for the case the opener survives (a
// hard redirect flow, or a future COOP value that permits it).
(function () {
  var payload = { ok: false, error: "Sign-in response could not be read." };

  try {
    var el = document.getElementById("intab-oauth-payload");
    var parsed = JSON.parse((el && el.textContent) || "null");
    if (parsed && typeof parsed === "object") payload = parsed;
  } catch (e) {
    /* keep the fallback payload */
  }

  var attr = document.currentScript && document.currentScript.getAttribute("data-target-origin");
  var targetOrigin = attr || window.location.origin;

  var message = { source: "intab-github-oauth", payload: payload };

  try {
    if (window.opener) {
      window.opener.postMessage(message, targetOrigin);
    }
  } catch (e) {
    /* opener gone or unreadable — the BroadcastChannel below is the real path */
  }

  try {
    var channel = new BroadcastChannel("intab-github-oauth");
    channel.postMessage(message);
    // Closed on the next turn: the message is already queued for delivery, and
    // the window is about to close anyway.
    setTimeout(function () {
      channel.close();
    }, 0);
  } catch (e) {
    /* no BroadcastChannel (an old browser) — the opener path had its chance */
  }

  setTimeout(function () {
    window.close();
  }, 150);
})();
