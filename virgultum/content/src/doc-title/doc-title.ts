import { effect, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  CodeBlockModel,
  ListBlockModel,
  type NoteBlockModel,
  ParagraphBlockModel,
  type RootBlockModel,
} from "@virgultum/core/models";
import { focusTextModel, type RichText } from "../rich-text/index";
import {
  EditorI18nProvider,
  MyoxusHostServiceIdentifier,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { getFirstNoteBlock, matchModels } from "@virgultum/core/utils";
import {
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import type { Store } from "@virgultum/core/store";

export const documentTitleStyles = `
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

export class DocTitle extends NativeViewElement {
  private _getOrCreateFirstPageVisibleNote() {
    const note = getFirstNoteBlock(this.doc);
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

  private readonly storeSignal = signal<Store>();
  private readonly placeholderSignal = signal<string>();
  private readonly wrapSignal = signal(true);
  private readonly composing = signal(false);
  private lifecycle?: DisposableGroup;
  private richText?: RichText;

  get doc() {
    return this.storeSignal.value!;
  }
  set doc(store: Store) {
    this.storeSignal.value = store;
  }
  get placeholder() {
    return this.placeholderSignal.value;
  }
  set placeholder(text: string | undefined) {
    this.placeholderSignal.value = text;
  }
  get wrapText() {
    return this.wrapSignal.value;
  }
  set wrapText(wrap: boolean) {
    this.wrapSignal.value = wrap;
  }
  get inlineEditor() {
    return this.richText?.inlineEditor;
  }
  get inlineEditorContainer() {
    return this.richText?.inlineEditorContainer;
  }
  get updateComplete() {
    return Promise.resolve(this.richText?.updateComplete);
  }

  connectedCallback() {
    installEditorStyles(this, documentTitleStyles);
    const life = (this.lifecycle = new DisposableGroup());
    life.addFromEvent(this, "keydown", this._onTitleKeyDown);
    life.addFromEvent(this, "compositionstart", () => {
      this.composing.value = true;
    });
    life.addFromEvent(this, "compositionend", () => {
      this.composing.value = false;
    });
    const container = this.ownerDocument.createElement("div");
    container.className = "doc-title-container";
    container.dataset.blockIsTitle = "true";
    life.addFromEvent(container, "contextmenu", this._onTitleContextMenu);
    this.replaceChildren(container);
    life.add(
      effect(() => {
        const store = this.storeSignal.value;
        const root = store?.root as RootBlockModel | null;
        if (!store || !root) return;
        const rich = (this.richText =
          this.ownerDocument.createElement("rich-text"));
        const text = root.props.title.yText;
        rich.yText = text;
        rich.undoManager = store.history.undoManager;
        rich.verticalScrollContainerGetter = () => this._viewport;
        rich.enableFormat = false;
        const disposeProps = effect(() => {
          rich.readonly = store.readonly;
          rich.wrapText = this.wrapText;
          container.dataset.placeholder =
            this.placeholder ??
            resolveEditorMessage(
              editorMessage("Title", "Title"),
              this._std?.getOptional(EditorI18nProvider) ?? undefined,
            );
        });
        const updateEmpty = () =>
          container.classList.toggle(
            "doc-title-container-empty",
            !text.length && !this.composing.value,
          );
        const disposeComposition = effect(() => {
          updateEmpty();
        });
        text.observe(updateEmpty);
        container.append(rich);
        return () => {
          text.unobserve(updateEmpty);
          disposeComposition();
          disposeProps();
          rich.remove();
          this.richText = undefined;
        };
      }),
    );
  }

  disconnectedCallback() {
    this.lifecycle?.dispose();
    this.composing.value = false;
    this.replaceChildren();
  }
}
