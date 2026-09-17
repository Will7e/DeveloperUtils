// ============================================================
// Monaco Format Shortcut Helper
// Enables Cmd+S / Ctrl+S and Shift+Alt+F formatting across
// all Monaco editor instances.
// ============================================================

import type { editor } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { formatContent } from "@/services/formatter.service";
import { useAppStore } from "@/stores/app.store";

export interface RegisterFormatOptions {
  /** Custom formatting handler (e.g. store updates, toast handling) */
  onFormat?: () => void | Promise<void>;
  /** Optional language getter or override */
  getLanguage?: () => string;
}

/**
 * Attaches Cmd+S / Ctrl+S and Shift+Alt+F format commands and context menu action
 * to a Monaco code editor instance.
 */
export function registerMonacoFormatShortcut(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  options?: RegisterFormatOptions
): () => void {
  const handler = async () => {
    if (options?.onFormat) {
      await options.onFormat();
      return;
    }

    // Default formatting behavior for general editors
    const isReadOnly = editorInstance.getOption(monaco.editor.EditorOption.readOnly);
    if (isReadOnly) return;

    const val = editorInstance.getValue();
    if (!val || !val.trim()) return;

    const lang = options?.getLanguage
      ? options.getLanguage()
      : editorInstance.getModel()?.getLanguageId() || "plaintext";

    try {
      const res = await formatContent(val, lang);
      if (res.success && res.formatted !== val) {
        editorInstance.setValue(res.formatted);
        useAppStore.getState().addToast({
          message: `Formatted (${lang.toUpperCase()})`,
          type: "success",
          duration: 1500,
        });
      } else if (!res.success && res.error) {
        useAppStore.getState().addToast({
          message: `Formatting: ${res.error}`,
          type: "info",
          duration: 2000,
        });
      }
    } catch {
      // Ignore
    }
  };

  // Add Cmd+S / Ctrl+S command
  editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, handler);

  // Add Shift+Alt+F (VS Code standard formatting)
  editorInstance.addCommand(
    monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
    handler
  );

  // Add to editor action menu / context menu
  const actionDisposable = editorInstance.addAction({
    id: "devutils.formatDocument",
    label: "Format Document",
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
    ],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 1.5,
    run: handler,
  });

  return () => {
    actionDisposable.dispose();
  };
}
