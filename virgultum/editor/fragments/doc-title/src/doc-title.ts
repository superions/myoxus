import { effect } from "@preact/signals-core";
import { WithDisposable, SignalWatcher } from "@virgultum/global/lit";
import {
  CodeBlockModel,
  ListBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
  ParagraphBlockModel,
  type RootBlockModel,
} from "@virgultum/model";
import { focusTextModel, type RichText } from "@virgultum/rich-text";
import {
  EditorI18nProvider,
  MyoxusHostServiceIdentifier,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import { matchModels } from "@virgultum/shared/utils";
import { ShadowlessElement } from "@virgultum/std";
import type { Store } from "@virgultum/store";
import { css, html } from "lit";
import { property, query, state } from "lit/decorators.js";

export class DocTitle extends SignalWatcher(WithDisposable(ShadowlessElement)) {
  static override styles = css`
    .doc-title-container {
      font-family: var(--myoxus-typography-page-title-family);
      font-size: calc(
        var(--myoxus-typography-page-title-size) *
          var(--myoxus-document-reading-scale, 1)
      );
      line-height: var(--myoxus-typography-page-title-line-height);
      font-weight: var(--myoxus-typography-page-title-weight);
      font-style: var(--myoxus-typography-page-title-font-style);
      letter-spacing: var(--myoxus-typography-page-title-letter-spacing);
      text-transform: var(--myoxus-typography-page-title-text-transform, none);
      text-decoration: var(--myoxus-typography-page-title-decoration, none);
    }
    .doc-icon-container,
    .doc-title-container {
      box-sizing: border-box;
      color: var(--myoxus-text-primary-color);
      outline: none;
      resize: none;
      border: 0;
      width: 100%;
      max-width: var(--myoxus-editor-width);
      margin-left: auto;
      margin-right: auto;
      padding: calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs)) 0;

      /* Document insets are projected by the app/facade shell. Keep the
         fragment itself token-driven so it does not own a parallel viewport
         spacing system. */
      padding-left: var(
        --myoxus-editor-content-padding-inline,
        var(--mantine-spacing-md)
      );
      padding-right: var(
        --myoxus-editor-content-padding-inline,
        var(--mantine-spacing-md)
      );
    }
    .doc-icon-container + * .doc-title-container {
      /* when doc icon exists, remove the top padding */
      padding-top: 0;
    }

    /* Keep this aligned with the Myoxus/Mantine sm breakpoint projection. */
    @container viewport (width <= 48em) {
      .doc-icon-container,
      .doc-title-container {
        padding-left: var(--mantine-spacing-md);
        padding-right: var(--mantine-spacing-md);
      }
    }

    .doc-title-container-empty::before {
      content: attr(data-placeholder);
      color: var(--myoxus-placeholder-color);
      position: absolute;
      opacity: 0.5;
      pointer-events: none;
    }

    .doc-title-container:disabled {
      background-color: transparent;
    }
  `;

  private _getOrCreateFirstPageVisibleNote() {
    const note = this._rootModel?.children.find(
      (child): child is NoteBlockModel =>
        matchModels(child, [NoteBlockModel]) &&
        child.props.displayMode !== NoteDisplayMode.EdgelessOnly,
    );
    if (note) return note;

    const noteId = this.doc.addBlock("myoxus:note", {}, this._rootModel, 0);
    return this.doc.getBlock(noteId)?.model as NoteBlockModel;
  }

  private readonly _onTitleKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || this.doc.readonly) return;
    if (!this._std) return;

    if (event.key === "Enter") {
      this._std.event.active = true;
      event.preventDefault();
      event.stopPropagation();

      const inlineRange = this.inlineEditor?.getInlineRange();
      if (inlineRange) {
        const rightText = this._rootModel?.props.title.split(inlineRange.index);
        const newFirstParagraphId = this.doc.addBlock(
          "myoxus:paragraph",
          { text: rightText },
          this._getOrCreateFirstPageVisibleNote(),
          0,
        );
        if (this._std) focusTextModel(this._std, newFirstParagraphId);
      }
    } else if (event.key === "ArrowDown") {
      this._std.event.active = true;
      event.preventDefault();
      event.stopPropagation();

      const note = this._getOrCreateFirstPageVisibleNote();
      const firstText = note?.children.find((block) =>
        matchModels(block, [
          ParagraphBlockModel,
          ListBlockModel,
          CodeBlockModel,
        ]),
      );
      if (firstText) {
        if (this._std) focusTextModel(this._std, firstText.id);
      } else {
        const newFirstParagraphId = this.doc.addBlock(
          "myoxus:paragraph",
          {},
          note,
          0,
        );
        if (this._std) focusTextModel(this._std, newFirstParagraphId);
      }
    } else if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly _onTitleContextMenu = (event: MouseEvent) => {
    const std = this._std;
    const host = std?.getOptional(MyoxusHostServiceIdentifier);
    const capabilities = host?.getTemplateVariableCapabilities() ?? [];
    if (
      !std ||
      this.doc.readonly ||
      !host?.isTemplateDocument() ||
      !capabilities.length ||
      !host.openTemplateVariablePicker
    )
      return;
    const inlineEditor = this.inlineEditor;
    if (!inlineEditor) return;
    const range = inlineEditor.getInlineRange() ?? {
      index: this._rootModel?.props.title.length ?? 0,
      length: 0,
    };
    let nextCaret = range.index;
    event.preventDefault();
    event.stopPropagation();
    host.openTemplateVariablePicker({
      i18n: std.getOptional(EditorI18nProvider) ?? undefined,
      canWrite: () =>
        !this.doc.readonly &&
        this.isConnected &&
        Boolean(
          this._std
            ?.getOptional(MyoxusHostServiceIdentifier)
            ?.isTemplateDocument(),
        ),
      insert: (token) => {
        this.doc.captureSync();
        inlineEditor.insertText(range, token);
        nextCaret = range.index + token.length;
        this.doc.captureSync();
      },
      onClose: () => {
        if (this.isConnected)
          inlineEditor.setInlineRange({ index: nextCaret, length: 0 });
      },
    });
  };

  private get _std() {
    return this._viewport?.querySelector("editor-host")?.std;
  }

  private get _rootModel() {
    return this.doc.root as RootBlockModel | null;
  }

  private get _viewport() {
    return (
      this.closest<HTMLElement>(".myoxus-page-viewport") ??
      this.closest<HTMLElement>(".myoxus-edgeless-viewport")
    );
  }

  get inlineEditor() {
    return this._richTextElement.inlineEditor;
  }

  get inlineEditorContainer() {
    return this._richTextElement.inlineEditorContainer;
  }

  override connectedCallback() {
    super.connectedCallback();

    this._isReadonly = this.doc.readonly;
    this._disposables.add(
      effect(() => {
        if (this._isReadonly !== this.doc.readonly) {
          this._isReadonly = this.doc.readonly;
          this.requestUpdate();
        }
      }),
    );

    this._disposables.addFromEvent(this, "keydown", this._onTitleKeyDown);

    // Workaround for inline editor skips composition event
    this._disposables.addFromEvent(
      this,
      "compositionstart",
      () => (this._isComposing = true),
    );

    this._disposables.addFromEvent(
      this,
      "compositionend",
      () => (this._isComposing = false),
    );

    const requestTitleUpdate = () => this.requestUpdate();

    if (this._rootModel) {
      const rootModel = this._rootModel;
      rootModel.props.title.yText.observe(requestTitleUpdate);
      this._disposables.add(() => {
        rootModel.props.title.yText.unobserve(requestTitleUpdate);
      });
    }
  }

  override render() {
    const isEmpty = !this._rootModel?.props.title.length && !this._isComposing;

    return html`
      <div
        class="doc-title-container ${
          isEmpty ? "doc-title-container-empty" : ""
        }"
        data-block-is-title="true"
        data-placeholder=${this.placeholder ?? resolveEditorMessage(editorMessage("Title", "Title"), this._std?.getOptional(EditorI18nProvider) ?? undefined)}
        @contextmenu=${this._onTitleContextMenu}
      >
        <rich-text
          .yText=${this._rootModel?.props.title.yText}
          .undoManager=${this.doc.history.undoManager}
          .verticalScrollContainerGetter=${() => this._viewport}
          .readonly=${this.doc.readonly}
          .enableFormat=${false}
          .wrapText=${this.wrapText}
        ></rich-text>
      </div>
    `;
  }

  @state()
  private accessor _isComposing = false;

  @state()
  private accessor _isReadonly = false;

  @query("rich-text")
  private accessor _richTextElement!: RichText;

  @property({ attribute: false })
  accessor doc!: Store;

  @property({ attribute: false })
  accessor placeholder: string | undefined;

  @property({ attribute: false })
  accessor wrapText = true;
}
