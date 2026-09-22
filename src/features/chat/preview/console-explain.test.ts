// The reported symptom this answers: an app that logs
// `No routes matched location "srcdoc"` on every load and renders nothing.
// The warning is the harness talking, and the fix belongs in the message.

import { describe, it, expect } from "vitest";
import { explainConsoleEntry } from "./console-explain";

describe("explainConsoleEntry", () => {
  it("names the fix when a router cannot match in the sandbox", () => {
    const hint = explainConsoleEntry('No routes matched location "srcdoc"', { hosted: false });
    expect(hint).toContain("srcdoc");
    expect(hint).toContain("npm run dev");
    expect(hint).toContain("served from");
  });

  it("stays quiet once the build has a real origin", () => {
    // With a real origin the routes match, so the warning is about the app.
    expect(explainConsoleEntry('No routes matched location "/"', { hosted: true })).toBeNull();
    expect(explainConsoleEntry('No routes matched location "srcdoc"', { hosted: true })).toBeNull();
  });

  it("leaves the app's own output alone", () => {
    const lines = [
      "hello from the app",
      "GET https://api.example/x 404",
      "Warning: Each child in a list should have a unique key prop.",
      "@supabase/gotrue-js: Navigator LockManager returned a null lock",
    ];
    for (const line of lines) {
      expect(explainConsoleEntry(line, { hosted: false }), line).toBeNull();
    }
  });
});
