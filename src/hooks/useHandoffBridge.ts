// ============================================================
// useHandoffBridge — applies dashboard demo handoffs
// ============================================================
// Mounted once (in MainLayout). Listens for handoff requests, seeds the
// target tool's store state, then navigates. Tool pages stay unaware of
// the handoff mechanism entirely.
//
// THE APPLYING HALF LIVES IN A SERVICE (services/handoff-bridge.ts), not
// here: the chat agent's `open_in_tool` tool seeds the same stores with the
// same function, and a hook module is the wrong thing to import from a code
// path that runs between model rounds. This file now owns exactly one thing
// pages cannot do themselves — turning a target into a router navigation —
// and it serves both the full request and a navigation-only signal, which
// the agent fires after applying the payload itself so nothing is applied
// twice.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  HANDOFF_EVENT,
  HANDOFF_NAVIGATE_EVENT,
  HANDOFF_ROUTES,
  clearStoredHandoff,
  readStoredHandoff,
  type HandoffPayload,
  type HandoffTarget,
} from "@/services/handoff.service";
import { applyHandoff } from "@/services/handoff-bridge";

export { applyHandoff };

export function useHandoffBridge(): void {
  const navigate = useNavigate();
  const hasConsumedOnMount = useRef(false);

  useEffect(() => {
    const run = (payload: HandoffPayload) => {
      if (!applyHandoff(payload)) return;
      clearStoredHandoff();
      navigate(HANDOFF_ROUTES[payload.target]);
    };

    const handleEvent = (event: Event) => {
      const detail = (event as CustomEvent<HandoffPayload>).detail;
      if (detail?.target) run(detail);
    };

    // Navigation-only: the payload was already applied by the caller (the
    // agent's open_in_tool), so this must NOT apply it again.
    const handleNavigate = (event: Event) => {
      const target = (event as CustomEvent<HandoffTarget>).detail;
      if (target && HANDOFF_ROUTES[target]) navigate(HANDOFF_ROUTES[target]);
    };

    window.addEventListener(HANDOFF_EVENT, handleEvent);
    window.addEventListener(HANDOFF_NAVIGATE_EVENT, handleNavigate);

    // A staged payload that outlived its event (reload, or a handoff
    // requested before the bridge mounted) is applied exactly once.
    if (!hasConsumedOnMount.current) {
      hasConsumedOnMount.current = true;
      const stored = readStoredHandoff();
      if (stored) run(stored);
    }

    return () => {
      window.removeEventListener(HANDOFF_EVENT, handleEvent);
      window.removeEventListener(HANDOFF_NAVIGATE_EVENT, handleNavigate);
    };
  }, [navigate]);
}
