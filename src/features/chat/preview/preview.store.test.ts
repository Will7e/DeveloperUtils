// ============================================================
// Agent Panel Visibility — Regression Tests
// ============================================================
// The panel's visibility is derived from the repo attachment, not
// toggled by a button, and the one time that went wrong the panel
// simply never appeared on its own — a silent failure, because a
// missing panel looks exactly like a panel the user never opened.
// These tests pin the rule itself.

import { describe, it, expect } from "vitest";
import { isAgentPanelVisible } from "./preview.store";

describe("isAgentPanelVisible", () => {
  it("opens the panel as soon as a repository is attached", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 1000, closedForAttachment: null })
    ).toBe(true);
  });

  it("stays closed for the attachment the user dismissed", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 1000, closedForAttachment: 1000 })
    ).toBe(false);
  });

  it("reopens when the panel is asked for again (stamp cleared)", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 1000, closedForAttachment: null })
    ).toBe(true);
  });

  it("reopens for a NEW attachment even though an older one was dismissed", () => {
    expect(
      isAgentPanelVisible({ repoAttached: true, attachedAt: 2000, closedForAttachment: 1000 })
    ).toBe(true);
  });

  it("never shows without a repository — there is no workspace to report on", () => {
    expect(
      isAgentPanelVisible({ repoAttached: false, attachedAt: 0, closedForAttachment: null })
    ).toBe(false);
    expect(
      isAgentPanelVisible({ repoAttached: false, attachedAt: 0, closedForAttachment: 1000 })
    ).toBe(false);
  });
});
