// ============================================================
// User Stop — The One Sentence Every Cancelled Run Reports
// ============================================================
// "Stopped by the user" is reported by every cancellable runner: the browser
// workspace's executor, the chat tools and the turn engine. One sentence, one
// module, so a cancelled run reads the same everywhere it surfaces — and so
// nobody can quietly reword it into something a transcript would misread as a
// failure of the code rather than an act of the user.
//
// Deliberately not a UI string and not part of a richer error type: it is a
// contract with the model, quoted verbatim in tool results.
// ============================================================

/** The verdict for any run the user cancelled before it finished. */
export const STOPPED_BY_USER =
  "Stopped by the user before it finished — nothing was verified.";
