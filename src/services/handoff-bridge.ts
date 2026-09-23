// ============================================================
// Handoff Bridge — apply a payload to the target tool's stores
// ============================================================
// The dashboard demos hand their state to the matching tool so "open this
// in the real thing" lands on real content instead of an empty editor.
// Applying a payload is pure store writes and nothing else — no React, no
// routing — which is what lets the chat agent's `open_in_tool` reuse it:
// the agent seeds the tool's stores with exactly the same function the
// demos use, and the mounted bridge (hooks/useHandoffBridge) owns the
// navigation for both callers.
//
// Kept as a service rather than a hook for that reason. It was inside the
// hook file until an agent tool needed it, and importing a hook module from
// a chat service would have pulled React and the router into a code path
// that runs between model rounds.

import { useAppStore } from "@/stores/app.store";
import { useApiTesterStore } from "@/stores/api-tester.store";
import { useChatStore } from "@/stores/chat.store";
import { stageChatDraft, type HandoffPayload } from "./handoff.service";

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
      toast("Dropped the demo prompt into Agents");
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
