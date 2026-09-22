// Prevents a theme flash on load: applies the persisted light theme before
// first paint. Extracted from index.html so the production CSP can forbid
// inline scripts entirely (see the note in index.html).
try {
  const theme = localStorage.getItem("intab_theme") || localStorage.getItem("devutils_theme");
  if (theme === "light") {
    document.documentElement.classList.add("light");
  } else if (!theme) {
    const stateStr =
      localStorage.getItem("intab-app-state") || localStorage.getItem("devutils-app-state");
    if (stateStr) {
      const state = JSON.parse(stateStr);
      if (
        state &&
        state.state &&
        state.state.editorSettings &&
        state.state.editorSettings.theme === "light"
      ) {
        document.documentElement.classList.add("light");
      }
    }
  }
} catch (e) {
  /* storage unavailable or unreadable — fall back to the dark default */
}
