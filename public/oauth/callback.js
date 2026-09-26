// ============================================================
// Cloud Sync OAuth callback — completes the PKCE exchange
// ============================================================
// External file on purpose: production ships a strict CSP without
// 'unsafe-inline', which silently blocks inline scripts. The earlier
// inline version of this logic never executed on in-tab.se, so sign-in
// died on this page for every provider while the opener read it as a
// cancelled popup.
//
// The provider returns the authorization response either in the query
// (?code=…) or, for Microsoft redirect URIs registered as platform
// "SPA", in the fragment (#code=…) regardless of response_mode. Both
// are parsed here.
//
// THREE delivery channels back to the opener, mirroring
// github-popup.js: localStorage (primary — the opener polls it),
// postMessage (when the opener survived COOP), and BroadcastChannel
// (per-origin, reaches the app even when COOP: same-origin nulled the
// opener after the popup crossed to accounts.google.com /
// login.microsoftonline.com).
(function () {
  "use strict";

  var HANDOFF_PREFIX = "intab_oauth_handoff_";
  var RESULT_PREFIX = "intab_oauth_result_";
  var CHANNEL_NAME = "intab-cloud-sync-oauth";
  var FLOW_MAX_AGE_MS = 15 * 60 * 1000;

  var spinner = document.getElementById("spinner");
  var messageEl = document.getElementById("message");
  var errorEl = document.getElementById("error");
  var hintEl = document.getElementById("hint");

  // Query string or fragment, whichever carries the response.
  function authResponseParams() {
    if (window.location.hash && window.location.hash.length > 1) {
      return new URLSearchParams(window.location.hash.slice(1));
    }
    return new URLSearchParams(window.location.search);
  }

  function showFailure(message) {
    if (spinner) spinner.style.display = "none";
    if (messageEl) messageEl.textContent = "Sign-in failed";
    if (errorEl) errorEl.textContent = message;
    if (hintEl) hintEl.style.display = "block";
  }

  function deliver(stateKey, payload) {
    // localStorage first: it is the channel the opener can always read
    // (same origin), even when postMessage/BroadcastChannel are gone.
    try {
      localStorage.setItem(RESULT_PREFIX + stateKey, JSON.stringify(payload));
    } catch (e) {
      /* storage unavailable — the broadcast channels below still fire */
    }

    var message = { type: "intab-oauth-complete", state: stateKey };
    if (payload.ok) message.tokens = payload.tokens;
    else message.error = payload.error;

    try {
      if (window.opener) {
        window.opener.postMessage(message, window.location.origin);
      }
    } catch (e) {
      /* opener gone (COOP) or cross-origin — BroadcastChannel is the backup */
    }

    try {
      var channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(message);
      setTimeout(function () {
        channel.close();
      }, 0);
    } catch (e) {
      /* no BroadcastChannel — localStorage remains */
    }

    // Success closes itself; failure stays open so the user can read why.
    if (payload.ok) {
      setTimeout(function () {
        window.close();
      }, 400);
    }
  }

  function fail(stateKey, message) {
    deliver(stateKey, { ok: false, error: message });
    showFailure(message);
  }

  function succeed(stateKey, tokens) {
    deliver(stateKey, { ok: true, tokens: tokens });
  }

  // The PKCE verifier handoff written by the opener before the popup
  // opened. Looked up by state; a newest-valid scan covers storage
  // events lost to duplicated windows or a same-state retry.
  function readHandoff(stateKey) {
    var flow = null;
    try {
      flow = JSON.parse(localStorage.getItem(HANDOFF_PREFIX + stateKey) || "null");
    } catch (e) {
      flow = null;
    }
    if (isValidHandoff(flow)) return flow;

    // Newest valid handoff within the freshness window.
    try {
      var newest = null;
      var newestStartedAt = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(HANDOFF_PREFIX) !== 0) continue;
        var item = null;
        try {
          item = JSON.parse(localStorage.getItem(k) || "null");
        } catch (e2) {
          continue;
        }
        if (!isValidHandoff(item)) continue;
        if (Date.now() - item.startedAt > FLOW_MAX_AGE_MS) continue;
        if (item.startedAt > newestStartedAt) {
          newest = item;
          newestStartedAt = item.startedAt;
        }
      }
      return newest;
    } catch (e3) {
      return null;
    }
  }

  function isValidHandoff(flow) {
    return !!(
      flow &&
      typeof flow.verifier === "string" &&
      flow.verifier.length > 0 &&
      typeof flow.clientId === "string" &&
      flow.clientId.length > 0 &&
      (flow.provider === "googledrive" || flow.provider === "onedrive")
    );
  }

  // The exchange runs server-side via /api/oauth-exchange: Google's client
  // is a "Web application" whose token endpoint demands client_secret — a
  // value that must never reach the browser bundle. Microsoft's SPA client
  // needs no secret but rides the same endpoint for one shared code path.
  function exchange(flow, code) {
    return fetch("/api/oauth-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: flow.provider,
        code: code,
        codeVerifier: flow.verifier,
      }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return { ok: false, error: "Exchange endpoint returned a non-JSON response (HTTP " + res.status + ")." };
          })
          .then(function (json) {
            if (!res.ok || !json.ok) {
              throw new Error(json.error || "Token exchange failed (HTTP " + res.status + ").");
            }
            return json.tokens;
          });
      })
      .then(function (tokens) {
        if (!tokens || !tokens.accessToken) {
          throw new Error("Token exchange returned no access token.");
        }
        return tokens;
      });
  }

  function run() {
    var params = authResponseParams();
    var stateKey = params.get("state");

    if (params.get("error")) {
      fail(stateKey || "", params.get("error_description") || params.get("error") || "Sign-in failed.");
      return;
    }

    var code = params.get("code");
    if (!code || !stateKey) {
      fail("", "Missing authorization code or state.");
      return;
    }

    var flow = readHandoff(stateKey);
    if (!flow) {
      fail(
        stateKey,
        "Sign-in session expired. If you started sign-in on localhost, ensure the redirect landed on localhost (not in-tab.se), or vice-versa."
      );
      return;
    }

    exchange(flow, code).then(
      function (tokens) {
        try {
          localStorage.removeItem(HANDOFF_PREFIX + stateKey);
        } catch (e) {
          /* the opener's consume cleans this too */
        }
        succeed(stateKey, tokens);
      },
      function (err) {
        fail(stateKey, (err && err.message) || "Token exchange failed.");
      }
    );
  }

  run();
})();
