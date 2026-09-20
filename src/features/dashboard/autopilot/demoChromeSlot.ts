// ============================================================
// Demo chrome slot
// ============================================================
// Demo controls need the autopilot handle, which lives inside the demo
// body — but they look wrong crowding the demo's own toolbar. This
// context carries the title-bar slot so a demo can render its controls
// into the window chrome while still owning the state behind them.

import { createContext } from "react";

export const DemoChromeSlotContext = createContext<HTMLElement | null>(null);
