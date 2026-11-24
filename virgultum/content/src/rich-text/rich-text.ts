import { effect, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { hasPendingAnnotationInput } from "@virgultum/core/adapters";
import type {
  MyoxusInlineEditor,
  MyoxusTextAttributes,
} from "@virgultum/core/types";
import {
  installEditorStyles,
  NativeViewElement,
} from "@virgultum/core/runtime";
import {
  type AttributeRenderer,
  InlineEditor,
  type InlineMarkdownMatch,
  type InlineRange,
  type InlineRangeProvider,
} from "@virgultum/core/runtime/inline";
import { type DeltaInsert, Text } from "@virgultum/core/store";
import * as Y from "yjs";
import { z } from "zod";

import { onVBeforeinput, onVCompositionEnd } from "./hooks";
import { getPrefixText } from "./utils";

interface RichTextStackItem {
  meta: Map<"richtext-v-range", InlineRange | null>;
}

const richTextStyles = `
    rich-text {
      display: block;
      height: 100%;
      width: 100%;
      overflow-x: auto;
      overflow-y: hidden;

      scroll-margin-top: 50px;
      scroll-margin-bottom: 30px;
    }

    .inline-editor {
      height: 100%;
      width: 100%;
      outline: none;
      cursor: text;
    }

    .inline-editor.readonly {
      cursor: default;
    }

    rich-text .nowrap-lines v-text span,
    rich-text .nowrap-lines v-element span {
      white-space: pre !important;
    }
  `;

export class RichText extends NativeViewElement {
  private disposables = new DisposableGroup();
  private container?: HTMLDivElement;
  private pending?: Promise<void>;
  #verticalScrollContainer: HTMLElement | null = null;

  private readonly _inlineEditor$ = signal<MyoxusInlineEditor | null>(null);

  private readonly _onCopy = (e: ClipboardEvent) => {
    const inlineEditor = this.inlineEditor;
    if (!inlineEditor) return;

    const inlineRange = inlineEditor.getInlineRange();
    if (!inlineRange) return;

    const text = inlineEditor.yTextString.slice(
      inlineRange.index,
      inlineRange.index + inlineRange.length,
    );

    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly _onCut = (e: ClipboardEvent) => {
    const inlineEditor = this.inlineEditor;
    if (!inlineEditor) return;

    const inlineRange = inlineEditor.getInlineRange();
    if (!inlineRange) return;

    const text = inlineEditor.yTextString.slice(
      inlineRange.index,
      inlineRange.index + inlineRange.length,
    );
    inlineEditor.deleteText(inlineRange);
    inlineEditor.setInlineRange({
      index: inlineRange.index,
      length: 0,
    });

    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly _onPaste = (e: ClipboardEvent) => {
    const inlineEditor = this.inlineEditor;
    if (!inlineEditor) return;

    const inlineRange = inlineEditor.getInlineRange();
    if (!inlineRange) return;

    const text = e.clipboardData
      ?.getData("text/plain")
      ?.replace(/\r?\n|\r/g, "\n");
    if (!text) return;

    inlineEditor.insertText(inlineRange, text);
    inlineEditor.setInlineRange({
      index: inlineRange.index + text.length,
      length: 0,
    });

    e.preventDefault();
    e.stopPropagation();
  };

  private readonly _onStackItemAdded = (event: {
    stackItem: RichTextStackItem;
  }) => {
    const inlineRange = this.inlineEditor?.getInlineRange();
    if (inlineRange) {
      event.stackItem.meta.set("richtext-v-range", inlineRange);
    }
  };

  private readonly _onStackItemPopped = (event: {
    stackItem: RichTextStackItem;
  }) => {
    const inlineRange = event.stackItem.meta.get("richtext-v-range");
    if (inlineRange && this.inlineEditor?.isValidInlineRange(inlineRange)) {
      this.inlineEditor?.setInlineRange(inlineRange);
    }
  };

  private get _yText() {
    return this.yText instanceof Text ? this.yText.yText : this.yText;
  }

  // It will listen ctrl+z/ctrl+shift+z and call undoManager.undo/redo, keydown event will not
  get inlineEditor() {
    return this._inlineEditor$.value;
  }

  get inlineEditorContainer() {
    return this.container!;
  }

  private _init() {
    if (this.inlineEditor) {
      console.error("Inline editor already exists.");
      return;
    }

    if (!this.enableFormat) {
      this.attributesSchema = z.object({});
    }

    // init inline editor
    this._inlineEditor$.value = new InlineEditor<MyoxusTextAttributes>(
      this._yText,
      {
        isEmbed: (delta) => this.embedChecker(delta),
        hooks: {
          beforeinput: onVBeforeinput,
          compositionEnd: onVCompositionEnd,
        },
        inlineRangeProvider: this.inlineRangeProvider,
        lineNumbers: this.lineNumbers,
      },
    );
    const inlineEditor = this._inlineEditor$.value;
    if (this.attributesSchema) {
      inlineEditor.setAttributeSchema(this.attributesSchema);
    }
    if (this.attributeRenderer) {
      inlineEditor.setAttributeRenderer(this.attributeRenderer);
    }

    const markdownMatches = this.markdownMatches;
    if (markdownMatches) {
      const markdownTransform = (isEnter: boolean = false, input = " ") => {
        let inlineRange = inlineEditor.getInlineRange();
        if (!inlineRange) return false;

        const linePrefix = getPrefixText(inlineEditor);
        let pendingAnnotation: boolean | undefined;

        for (const match of markdownMatches) {
          const { pattern, action } = match;
          if (
            !isEnter &&
            !(match.trigger ? input.endsWith(match.trigger) : input === " ")
          )
            continue;
          if (match.name !== "annotation") {
            pendingAnnotation ??= hasPendingAnnotationInput(
              inlineEditor.yText.toDelta(),
              inlineRange.index,
            );
            if (pendingAnnotation) continue;
          }
          let prefixText = match.fullPrefix
            ? inlineEditor.yTextString.slice(0, inlineRange.index)
            : linePrefix;
          if (isEnter) prefixText += " ";
          if (prefixText.match(pattern)) {
            if (isEnter) {
              inlineEditor.insertText(
                {
                  index: inlineRange.index,
                  length: 0,
                },
                " ",
              );
              inlineEditor.setInlineRange({
                index: inlineRange.index + 1,
                length: 0,
              });
              inlineRange = inlineEditor.getInlineRange();
              if (!inlineRange) return false;
            }

            const undoManager = this.undoManager;
            if (!undoManager) return false;
            const applied = action({
              inlineEditor,
              prefixText,
              inlineRange,
              pattern,
              undoManager,
            });
            if (applied === false) continue;
            return true;
          }
        }
        return false;
      };

      inlineEditor.disposables.add(
        inlineEditor.slots.inputting.subscribe((data) => {
          if (!inlineEditor.isComposing) {
            markdownTransform(false, data);
          }
        }),
      );

      inlineEditor.disposables.add(
        inlineEditor.slots.keydown.subscribe((event) => {
          if (event.key === "Enter" && markdownTransform(true)) {
            event.stopPropagation();
            event.preventDefault();
          }
        }),
      );
    }

    // init auto scroll
    inlineEditor.disposables.add(
      effect(() => {
        const inlineRange = inlineEditor.inlineRange$.value;
        if (!inlineRange) return;

        // lazy
        const verticalScrollContainer =
          this.#verticalScrollContainer ||
          (this.#verticalScrollContainer =
            this.verticalScrollContainerGetter?.() || null);

        inlineEditor
          .waitForUpdate()
          .then(() => {
            if (!inlineEditor.mounted || inlineEditor.rendering) return;

            const range = inlineEditor.toDomRange(inlineRange);
            if (!range) return;

            if (verticalScrollContainer) {
              const nativeRange = inlineEditor.getNativeRange();
              if (
                !nativeRange ||
                nativeRange.commonAncestorContainer.parentElement?.contains(
                  inlineEditor.rootElement,
                )
              )
                return;

              const containerRect =
                verticalScrollContainer.getBoundingClientRect();
              const rangeRect = range.getBoundingClientRect();

              if (rangeRect.top < containerRect.top) {
                this.scrollIntoView({ block: "start" });
              } else if (rangeRect.bottom > containerRect.bottom) {
                this.scrollIntoView({ block: "end" });
              }
            }

            // scroll container is this
            if (this.enableAutoScrollHorizontally) {
              const containerRect = this.getBoundingClientRect();
              const rangeRect = range.getBoundingClientRect();

              let scrollLeft = this.scrollLeft;
              if (
                rangeRect.left + rangeRect.width >
                containerRect.left + containerRect.width
              ) {
                scrollLeft +=
                  rangeRect.left +
                  rangeRect.width -
                  (containerRect.left + containerRect.width) +
                  2;
              }
              this.scrollLeft = scrollLeft;
            }
          })
          .catch(console.error);
      }),
    );

    inlineEditor.mount(
      this.inlineEditorContainer,
      this.inlineEventSource,
      this.readonly,
    );
  }

  private _unmount() {
    if (this.inlineEditor?.mounted) {
      this.inlineEditor.unmount();
    }
    this._inlineEditor$.value = null;
  }

  connectedCallback() {
    installEditorStyles(this, richTextStyles);
    this.scheduleSync();
  }

  disconnectedCallback() {
    this.releaseBinding();
  }

  private releaseBinding() {
    this._unmount();
    this.disposables.dispose();
    this.#verticalScrollContainer = null;
  }

  private scheduleSync() {
    if (!this.isConnected || this.pending) return;
    // Parents assign text, rendering options and the undo owner in one turn.
    // Bind after assignment so a new model never uses the previous undo owner.
    this.pending = Promise.resolve().then(() => {
      this.pending = undefined;
      if (this.isConnected) this.sync();
    });
  }

  private sync() {
    const container = (this.container ??=
      this.ownerDocument.createElement("div"));
    if (container.parentElement !== this) this.append(container);
    container.classList.add("inline-editor");
    container.classList.toggle("nowrap-lines", !this.wrapText);
    container.classList.toggle("readonly", this.readonly);
    const editable = String(!this.readonly);
    if (container.contentEditable !== editable)
      container.contentEditable = editable;
    if (this.inlineEditor && this.inlineEditor.yText === this._yText) {
      if (this.inlineEditor.isReadonly !== this.readonly)
        this.inlineEditor.setReadonly(this.readonly);
      return;
    }
    this.releaseBinding();
    if (!this._yText?.doc) return;
    this.disposables = new DisposableGroup();
    const suppliedUndoManager = this.undoManager;
    const undoManager =
      suppliedUndoManager ??
      new Y.UndoManager(this._yText, {
        trackedOrigins: new Set([this._yText.doc.clientID]),
      });
    this.undoManager = undoManager;
    if (this.enableUndoRedo) {
      this.disposables.addFromEvent(this, "keydown", (e: KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey) {
          if (e.key === "z" || e.key === "Z") {
            if (e.shiftKey) {
              this.undoManager?.redo();
            } else {
              this.undoManager?.undo();
            }
            e.stopPropagation();
          }
        }
      });

      undoManager.on("stack-item-added", this._onStackItemAdded);
      undoManager.on("stack-item-popped", this._onStackItemPopped);
      this.disposables.add({
        dispose: () => {
          undoManager.off("stack-item-added", this._onStackItemAdded);
          undoManager.off("stack-item-popped", this._onStackItemPopped);
        },
      });
    }

    if (!suppliedUndoManager) {
      // A supplied manager belongs to the Store; only dispose the local fallback.
      this.disposables.add({
        dispose: () => {
          undoManager.destroy();
          if (this.undoManager === undoManager) this.undoManager = undefined;
        },
      });
    }

    if (this.enableClipboard) {
      this.disposables.addFromEvent(this, "copy", this._onCopy);
      this.disposables.addFromEvent(this, "cut", this._onCut);
      this.disposables.addFromEvent(this, "paste", this._onPaste);
    }

    this._init();
  }

  get updateComplete(): Promise<boolean> {
    return Promise.resolve(this.pending).then(async () => {
      await this.inlineEditor?.waitForUpdate();
      return this.isConnected;
    });
  }

  attributeRenderer: AttributeRenderer | undefined = undefined;

  attributesSchema: z.ZodType<MyoxusTextAttributes> | undefined = undefined;

  embedChecker: <
    TextAttributes extends MyoxusTextAttributes = MyoxusTextAttributes,
  >(
    delta: DeltaInsert<TextAttributes>,
  ) => boolean | string = () => false;

  enableAutoScrollHorizontally = true;

  // If it is true rich-text will prevent events related to clipboard bubbling up and handle them by itself.
  enableClipboard = true;

  // `attributesSchema` will be overwritten to `z.object({})` if `enableFormat` is false.
  enableFormat = true;

  // bubble up if pressed ctrl+z/ctrl+shift+z.
  enableUndoRedo = true;

  inlineEventSource: HTMLElement | undefined = undefined;

  inlineRangeProvider: InlineRangeProvider | undefined = undefined;

  markdownMatches: InlineMarkdownMatch<MyoxusTextAttributes>[] = [];

  private _readonly = false;
  get readonly() {
    return this._readonly;
  }
  set readonly(value: boolean) {
    if (this._readonly === value) return;
    this._readonly = value;
    this.scheduleSync();
  }

  // rich-text will create a undoManager if it is not provided.
  undoManager: Y.UndoManager | undefined;

  verticalScrollContainerGetter: (() => HTMLElement | null) | undefined =
    undefined;

  lineNumbers = false;

  private _wrapText = true;
  get wrapText() {
    return this._wrapText;
  }
  set wrapText(value: boolean) {
    if (this._wrapText === value) return;
    this._wrapText = value;
    this.scheduleSync();
  }

  private sourceText!: Y.Text | Text;
  get yText() {
    return this.sourceText;
  }
  set yText(value: Y.Text | Text) {
    if (this.sourceText === value) return;
    this.sourceText = value;
    this.scheduleSync();
  }
}
