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

  try {
    if (window.opener) {
      window.opener.postMessage({ source: "intab-github-oauth", payload: payload }, targetOrigin);
    }
  } catch (e) {
    /* opener gone or unreadable — the app side will time out */
  }

  setTimeout(function () {
    window.close();
  }, 150);
})();
