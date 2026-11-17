import { signal } from "@preact/signals-core";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { openFilesWith } from "@virgultum/core/utils";
import type { ExtensionType, Schema, Workspace } from "@virgultum/core/store";
import {
  type DocEmbedProvider,
  type EditorChromeHost,
  type EditorImportControls,
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "@virgultum/core/services";

import { HtmlTransformer } from "../transformers/html.js";
import { MarkdownTransformer } from "../transformers/markdown.js";

export type OnSuccessHandler = (
  pageIds: string[],
  options: { isWorkspaceFile: boolean; importedCount: number },
) => void;
export type OnFailHandler = (message: string) => void;
const SHOW_LOADING_SIZE = 1024 * 200;

/** Standalone imports use the same injected chrome host as other editor controls. */
export class ImportDoc extends ShadowlessElement {
  private readonly state = signal({ loading: false });
  private readonly controls: EditorImportControls = {
    getSnapshot: () => this.state.peek(),
    subscribe: (listener) => this.state.subscribe(listener),
    close: () => this.abortController.abort(),
    choose: (format) => {
      void this._import(format).catch((error: unknown) => {
        this.state.value = { loading: false };
        this.onFail?.(
          error instanceof Error
            ? error.message
            : resolveEditorMessage(
                editorMessage(
                  "com.myoxus.editor.import.failed",
                  "Import failed. Please try again.",
                ),
                this.i18n,
              ),
        );
      });
    },
  };

  constructor(
    private readonly chrome: EditorChromeHost,
    private readonly collection: Workspace,
    private readonly schema: Schema,
    private readonly extensions: ExtensionType[],
    private readonly onSuccess?: OnSuccessHandler,
    private readonly onFail?: OnFailHandler,
    private readonly abortController = new AbortController(),
    private readonly access?: DocEmbedProvider,
    private readonly i18n?: EditorI18nService,
  ) {
    super();
  }

  private async _import(format: "html" | "markdown") {
    const files = await openFilesWith(format === "html" ? "Html" : "Markdown");
    if (!files) return;
    const pageIds: string[] = [];
    for (const file of files) {
      const text = await file.text();
      const fileName = file.name.split(".").slice(0, -1).join(".");
      const needLoading = file.size > SHOW_LOADING_SIZE;
      if (needLoading) {
        this.hidden = false;
        this.state.value = { loading: true };
      } else {
        this.abortController.abort();
      }
      const options = {
        collection: this.collection,
        schema: this.schema,
        extensions: this.extensions,
        fileName,
      };
      const pageId =
        format === "html"
          ? await HtmlTransformer.importHTMLToDoc({ ...options, html: text })
          : (
              await MarkdownTransformer.importMarkdownToDoc({
                ...options,
                markdown: text,
                access: this.access,
              })
            ).docId;
      if (needLoading) this.abortController.abort();
      if (pageId) pageIds.push(pageId);
    }
    this.onSuccess?.(pageIds, {
      isWorkspaceFile: false,
      importedCount: pageIds.length,
    });
  }

  override render() {
    return this.chrome.renderImport(this.controls);
  }
}
