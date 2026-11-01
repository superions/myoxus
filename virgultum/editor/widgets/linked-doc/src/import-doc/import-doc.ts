import {
  CloseIcon,
  ExportToHTMLIcon,
  ExportToMarkdownIcon,
} from "@virgultum/components/icons";
import { WithDisposable, SignalWatcher } from "@virgultum/global/lit";
import { openFilesWith } from "@virgultum/shared/utils";
import type { ExtensionType, Schema, Workspace } from "@virgultum/store";
import {
  type DocEmbedProvider,
  editorMessage,
  resolveEditorMessage,
  type EditorI18nMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";
import { html, LitElement, type PropertyValues } from "lit";
import { query, state } from "lit/decorators.js";

import { HtmlTransformer } from "../transformers/html.js";
import { MarkdownTransformer } from "../transformers/markdown.js";
import { styles } from "./styles.js";

export type OnSuccessHandler = (
  pageIds: string[],
  options: { isWorkspaceFile: boolean; importedCount: number },
) => void;

export type OnFailHandler = (message: string) => void;

const SHOW_LOADING_SIZE = 1024 * 200;

export class ImportDoc extends SignalWatcher(WithDisposable(LitElement)) {
  static override styles = styles;

  constructor(
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

    this._loading = false;

    this.x = 0;
    this.y = 0;
    this._startX = 0;
    this._startY = 0;

    this._onMouseMove = this._onMouseMove.bind(this);
  }

  private async _importHtml() {
    const files = await openFilesWith("Html");
    if (!files) return;
    const pageIds: string[] = [];
    for (const file of files) {
      const text = await file.text();
      const needLoading = file.size > SHOW_LOADING_SIZE;
      const fileName = file.name.split(".").slice(0, -1).join(".");
      if (needLoading) {
        this.hidden = false;
        this._loading = true;
      } else {
        this.abortController.abort();
      }
      const pageId = await HtmlTransformer.importHTMLToDoc({
        collection: this.collection,
        schema: this.schema,
        extensions: this.extensions,
        html: text,
        fileName,
      });
      needLoading && this.abortController.abort();
      if (pageId) {
        pageIds.push(pageId);
      }
    }
    this._onImportSuccess(pageIds);
  }

  private async _importMarkDown() {
    const files = await openFilesWith("Markdown");
    if (!files) return;
    const pageIds: string[] = [];
    for (const file of files) {
      const text = await file.text();
      const fileName = file.name.split(".").slice(0, -1).join(".");
      const needLoading = file.size > SHOW_LOADING_SIZE;
      if (needLoading) {
        this.hidden = false;
        this._loading = true;
      } else {
        this.abortController.abort();
      }
      const { docId: pageId } = await MarkdownTransformer.importMarkdownToDoc({
        collection: this.collection,
        schema: this.schema,
        markdown: text,
        fileName,
        extensions: this.extensions,
        access: this.access,
      });
      needLoading && this.abortController.abort();
      if (pageId) {
        pageIds.push(pageId);
      }
    }
    this._onImportSuccess(pageIds);
  }

  private _onCloseClick(event: MouseEvent) {
    event.stopPropagation();
    this.abortController.abort();
  }

  private _onFail(message: string) {
    this.onFail?.(message);
  }

  private _startImport(importer: () => Promise<void>) {
    void importer().catch((error: unknown) => {
      this._onFail(
        error instanceof Error
          ? error.message
          : this._text(
              editorMessage(
                "com.myoxus.editor.import.failed",
                "Import failed. Please try again.",
              ),
            ),
      );
    });
  }

  private _onImportSuccess(
    pageIds: string[],
    options: { isWorkspaceFile?: boolean; importedCount?: number } = {},
  ) {
    const {
      isWorkspaceFile = false,
      importedCount: pagesImportedCount = pageIds.length,
    } = options;
    this.onSuccess?.(pageIds, {
      isWorkspaceFile,
      importedCount: pagesImportedCount,
    });
  }

  private _onMouseDown(event: MouseEvent) {
    this._startX = event.clientX - this.x;
    this._startY = event.clientY - this.y;
    window.addEventListener("mousemove", this._onMouseMove);
  }

  private _onMouseMove(event: MouseEvent) {
    this.x = event.clientX - this._startX;
    this.y = event.clientY - this._startY;
  }

  private _onMouseUp() {
    window.removeEventListener("mousemove", this._onMouseMove);
  }

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(message, this.i18n);
  }

  override render() {
    if (this._loading) {
      return html`
        <div class="overlay-mask"></div>
        <div class="container">
          <header
            class="loading-header"
            @mousedown="${this._onMouseDown}"
            @mouseup="${this._onMouseUp}"
          >
            <div>${this._text(editorMessage("Import", "Import"))}</div>
            <loader-element .width=${"50px"}></loader-element>
          </header>
          <div>
            ${this._text(editorMessage("com.myoxus.editor.import.progress-hint", "Importing the file may take some time, depending on document size and complexity."))}
          </div>
        </div>
      `;
    }
    return html`
      <div
        class="overlay-mask"
        @click="${() => this.abortController.abort()}"
      ></div>
      <div class="container">
        <header @mousedown="${this._onMouseDown}" @mouseup="${this._onMouseUp}">
          <icon-button height="28px" @click="${this._onCloseClick}">
            ${CloseIcon}
          </icon-button>
          <div>${this._text(editorMessage("Import", "Import"))}</div>
        </header>
        <div>
          ${this._text(editorMessage("com.myoxus.editor.import.supported-formats", "Myoxus supports Markdown and HTML document imports. Use the dedicated actions for workspace and Database imports."))}
        </div>
        <div class="button-container">
          <icon-button
            class="button-item"
            text="Markdown"
            @click="${() => this._startImport(() => this._importMarkDown())}"
          >
            ${ExportToMarkdownIcon}
          </icon-button>
          <icon-button
            class="button-item"
            text="HTML"
            @click="${() => this._startImport(() => this._importHtml())}"
          >
            ${ExportToHTMLIcon}
          </icon-button>
        </div>
      </div>
    `;
  }

  override updated(changedProps: PropertyValues) {
    if (changedProps.has("x") || changedProps.has("y")) {
      this.containerEl.style.transform = `translate(${this.x}px, ${this.y}px)`;
    }
  }

  @state()
  accessor _loading = false;

  @state()
  accessor _startX = 0;

  @state()
  accessor _startY = 0;

  @query(".container")
  accessor containerEl!: HTMLElement;

  @state()
  accessor x = 0;

  @state()
  accessor y = 0;
}
