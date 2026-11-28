import { signal } from "@preact/signals-core";
import type { ExtensionType, Schema, Workspace } from "@virgultum/core/store";
import { openFilesWith } from "@virgultum/core/utils";
import {
  type DocEmbedProvider,
  type EditorChromeHost,
  type EditorI18nService,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { HtmlTransformer } from "../transformers/html.js";
import { MarkdownTransformer } from "../transformers/markdown.js";

export function showImportModal({
  chrome,
  schema,
  collection,
  extensions,
  onSuccess,
  onFail,
  container = document.body,
  abortController = new AbortController(),
  access,
  i18n,
}: {
  chrome: EditorChromeHost;
  schema: Schema;
  collection: Workspace;
  extensions: ExtensionType[];
  onSuccess?: (
    pageIds: string[],
    options: { isWorkspaceFile: boolean; importedCount: number },
  ) => void;
  onFail?: (message: string) => void;
  multiple?: boolean;
  container?: HTMLElement;
  abortController?: AbortController;
  access?: DocEmbedProvider;
  i18n?: EditorI18nService;
}) {
  const close = () => abortController.abort();
  if (abortController.signal.aborted) return close;
  const state = signal({ loading: false });
  let choosing = false;
  async function choose(format: "html" | "markdown") {
    if (choosing || abortController.signal.aborted) return;
    choosing = true;
    try {
      const files = await openFilesWith(
        format === "html" ? "Html" : "Markdown",
      );
      if (!files?.length || abortController.signal.aborted) return;
      // Small imports close immediately. Their writes still belong to the chosen workspace.
      if (files.some((file) => file.size > 200 * 1024))
        state.value = { loading: true };
      else close();
      const ids: string[] = [];
      for (const file of files) {
        const fileName = file.name.split(".").slice(0, -1).join(".");
        const options = { collection, schema, extensions, fileName };
        const text = await file.text();
        const id =
          format === "html"
            ? await HtmlTransformer.importHTMLToDoc({ ...options, html: text })
            : (
                await MarkdownTransformer.importMarkdownToDoc({
                  ...options,
                  markdown: text,
                  access,
                })
              ).docId;
        if (id) ids.push(id);
      }
      close();
      onSuccess?.(ids, { isWorkspaceFile: false, importedCount: ids.length });
    } catch (error) {
      state.value = { loading: false };
      onFail?.(
        error instanceof Error
          ? error.message
          : resolveEditorMessage(
              editorMessage(
                "com.myoxus.editor.import.failed",
                "Import failed. Please try again.",
              ),
              i18n,
            ),
      );
    } finally {
      choosing = false;
    }
  }
  const dispose = chrome.mountImport(container, {
    getSnapshot: () => state.peek(),
    subscribe: (listener) => state.subscribe(listener),
    close,
    choose,
  });
  abortController.signal.addEventListener("abort", dispose, { once: true });
  return close;
}
