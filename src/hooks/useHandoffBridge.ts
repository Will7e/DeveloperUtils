// ============================================================
// useHandoffBridge — applies dashboard demo handoffs
// ============================================================
// Mounted once (in MainLayout). Listens for handoff requests, seeds the
// target tool's store state, then navigates. Tool pages stay unaware of
// the handoff mechanism entirely.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { useChatStore } from "@/stores/chat.store";
import {
  HANDOFF_EVENT,
  HANDOFF_ROUTES,
  clearStoredHandoff,
  readStoredHandoff,
  stageChatDraft,
  type HandoffPayload,
} from "@/services/handoff.service";

/** Seeds the target tool with the handoff payload. Pure store writes. */
export function applyHandoff(payload: HandoffPayload): boolean {
  const app = useAppStore.getState();
  const toast = (message: string) => app.addToast({ message, type: "success", duration: 2200 });

  switch (payload.target) {
    case "compiler": {
      if (!payload.compiler) return false;
      app.createFile(
        payload.compiler.fileName ?? "demo.ts",
        payload.compiler.language ?? "typescript",
        payload.compiler.code
      );
      toast(`Opened ${payload.compiler.fileName ?? "demo.ts"} in the Compiler`);
      return true;
    }

    case "api-tester": {
      if (!payload.request) return false;
      const api = useApiTesterStore.getState();
      api.addTab();
      const next = useApiTesterStore.getState();
      if (payload.request.method) next.setMethod(payload.request.method);
      next.setUrl(payload.request.url);
      if (payload.request.body) {
        next.setBodyType("json");
        next.setBodyValue(payload.request.body);
      }
      toast("Loaded the demo request in the API Tester");
      return true;
    }

    case "chat": {
      if (!payload.chat) return false;
      useChatStore.getState().createConversation();
      stageChatDraft(payload.chat.prompt);
      toast("Dropped the demo prompt into AI Chat");
      return true;
    }

    case "drawflows": {
      if (!payload.workflow) return false;
      app.createWorkflow(payload.workflow.name ?? "Demo architecture", payload.workflow.elements);
      toast("Opened the demo diagram in DrawFlows");
      return true;
    }

    case "formatters": {
      if (!payload.formatter) return false;
      const { type, content, name } = payload.formatter;
      app.setFormatterType(type);
      app.createFormatterFile(type, name);
      const fileId = useAppStore.getState().activeFormatterFileId[type];
      if (fileId) useAppStore.getState().updateFormatterFileContent(type, fileId, content);
      toast(`Loaded the demo ${type.toUpperCase()} into Formatters`);
      return true;
    }

    case "diff": {
      if (!payload.diff) return false;
      app.createDiffSession(payload.diff.name ?? "Demo comparison");
      const sessionId = useAppStore.getState().activeDiffSessionId;
      if (!sessionId) return false;
      useAppStore.getState().updateDiffSessionInput(sessionId, "original", payload.diff.original);
      useAppStore.getState().updateDiffSessionInput(sessionId, "modified", payload.diff.modified);
      if (payload.diff.language) {
        useAppStore.getState().updateDiffSessionLanguage(sessionId, payload.diff.language, false);
      }
      toast("Loaded the demo files into the Diff Checker");
      return true;
    }

    case "comparators": {
      if (!payload.comparator) return false;
      app.createComparatorSession(payload.comparator.name ?? "Demo audit", payload.comparator.mode ?? "env");
      const sessionId = useAppStore.getState().activeComparatorSessionId;
      if (!sessionId) return false;
      useAppStore.getState().updateComparatorSessionInput(sessionId, "a", payload.comparator.a);
      useAppStore.getState().updateComparatorSessionInput(sessionId, "b", payload.comparator.b);
      toast("Loaded the demo files into Comparators");
      return true;
    }

    case "library": {
      if (!payload.library) return false;
      if (payload.library.tab) app.setLibraryTab(payload.library.tab);
      if (payload.library.query !== undefined) app.setLibrarySearchQuery(payload.library.query);
      if (payload.library.itemId !== undefined) app.setLibrarySelectedItemId(payload.library.itemId);
      toast("Opened the reference in the Library");
      return true;
    }

    default:
      return false;
  }
}

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

    window.addEventListener(HANDOFF_EVENT, handleEvent);

    // A staged payload that outlived its event (reload, or a handoff
    // requested before the bridge mounted) is applied exactly once.
    if (!hasConsumedOnMount.current) {
      hasConsumedOnMount.current = true;
      const stored = readStoredHandoff();
      if (stored) run(stored);
    }

    return () => window.removeEventListener(HANDOFF_EVENT, handleEvent);
  }, [navigate]);
}
