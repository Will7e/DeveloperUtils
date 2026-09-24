// ============================================================
// Modal Dialog — The Four Things Every Gate Must Do
// ============================================================
// Chat's approval gates declared `role="dialog" aria-modal="true"` and then
// behaved like ordinary divs: Tab walked out of the dialog into the page behind
// it, Escape did nothing, and the page kept scrolling underneath. The settings
// modal had solved all three, which is exactly how a rule like this rots — the
// next dialog copies the markup and not the behaviour, and the gap is invisible
// until somebody tries to leave with the keyboard.
//
// So the behaviour lives here, and the two dialogs that gate the agent's external
// actions (a push to GitHub, a write to somebody else's service) use it. Those are
// the two where a stuck focus is not a nuisance: the agent's tool call is blocked
// on the answer, so a dialog that cannot be dismissed by keyboard is a turn the
// user cannot unblock.
//
// Scroll lock is reference-counted because dialogs do overlap — settings can be
// open behind an approval gate — and the first one to close must not unlock the
// page while the other is still up.

import React from "react";

/** Everything a dialog may contain that Tab should reach */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Overlapping dialogs: the page unlocks when the last one closes */
let scrollLocks = 0;
let previousOverflow = "";

function lockScroll(): () => void {
  if (scrollLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
  };
}

export interface ModalDialogOptions {
  /**
   * What Escape means. For a gate that must be answered, it is the refusal —
   * dismissive by default, never approving: a stray Escape must not ship a diff
   * or post a request.
   */
  onDismiss: () => void;
  /** Focus this element on open instead of the first focusable one */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Wires a dialog's panel: initial focus, focus trap, Escape, scroll lock, and
 * focus restoration to whatever opened it.
 *
 * Returns the ref to put on the element that contains the dialog's content.
 */
export function useModalDialog<T extends HTMLElement>({
  onDismiss,
  initialFocusRef,
}: ModalDialogOptions) {
  const panelRef = React.useRef<T>(null);

  // Focus on open, and give it back on close: a keyboard user who approved a push
  // should land back on the control they came from, not at the top of the page.
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // A control that already took focus on mount — React's `autoFocus`, or a
    // nested field the dialog deliberately focuses — WINS. Re-focusing the first
    // focusable here would silently override that intent, which is how an
    // "optional note" field stops being the place the caret lands.
    const alreadyFocused = Boolean(panel?.contains(document.activeElement));
    const target = alreadyFocused
      ? null
      : (initialFocusRef?.current ??
        panel?.querySelector<HTMLElement>(`[autofocus], ${FOCUSABLE_SELECTOR}`) ??
        panel);
    // `preventScroll` matters here: focusing the panel would otherwise yank the
    // page behind the dialog to the top before the user has read anything.
    target?.focus?.({ preventScroll: true });
    return () => previous?.focus?.();
    // Intentionally once per mount: a dialog that re-focuses on every render
    // would fight the user for the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The trap. Wrapping from last to first (and back) is what an aria-modal dialog
  // promises; without it Tab reaches the transcript behind the overlay, where the
  // user cannot see the focused control.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Escape. Deliberately a real dismissal rather than a visual hide: both gates
  // resolve their awaiting tool call as a refusal when cleared, so the turn
  // continues with "the user declined" instead of hanging on an unresolved
  // promise.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  React.useEffect(() => lockScroll(), []);

  return panelRef;
}
