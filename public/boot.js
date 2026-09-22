// Boot-time globals and the loading-screen dismissal control.
// Extracted from index.html so the production CSP can forbid inline scripts
// entirely (see the note in index.html). Loaded as a classic, synchronous
// script at the end of <body>, which is exactly where the inline version ran,
// so it still executes before any deferred module script.
window.EXCALIDRAW_ASSET_PATH = "/";

window.__INTAB_DISMISS_LOADER__ = function () {
  if (window.__INTAB_LOADER_DISMISSED__) return;
  window.__INTAB_LOADER_DISMISSED__ = true;
  const loader = document.getElementById("loading-screen");
  if (loader) {
    loader.classList.add("hidden");
    setTimeout(() => {
      try {
        loader.remove();
      } catch (e) {}
    }, 500);
  }
};
window.__DEVUTILS_DISMISS_LOADER__ = window.__INTAB_DISMISS_LOADER__;

// Safety fallback: guarantee the loading screen is dismissed even if the
// network stalls before the app mounts.
setTimeout(() => {
  window.__INTAB_DISMISS_LOADER__();
}, 3500);
