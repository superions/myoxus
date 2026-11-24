import {
  editorMessage,
  EditorI18nProvider,
  type EditorI18nMessage,
  resolveEditorMessage,
  BlockElementCommentManager,
  DocModeProvider,
  NotificationProvider,
} from "@virgultum/core/services";
import { computed, effect, type Signal, signal } from "@preact/signals-core";
import { selectionFrame } from "../../caption/selection-frame";
import type { BlockCaptionEditor } from "../../caption/caption-session";
import { IS_MAC, IS_MOBILE } from "@virgultum/core/primitives/env";
import { noop } from "@virgultum/core/primitives/utils";
import type { CodeBlockModel } from "@virgultum/core/models";
import { focusTextModel, type RichText } from "../../rich-text/index";
import {
  BRACKET_PAIRS,
  EDGELESS_TOP_CONTENTEDITABLE_SELECTOR,
} from "@virgultum/core/consts";

import { getViewportElement } from "@virgultum/core/utils";
import {
  NativeContainerBlock,
  type BlockComponent,
  BlockSelection,
  TextSelection,
} from "@virgultum/core/runtime";
import {
  getInlineRangeProvider,
  INLINE_ROOT_ATTR,
  type InlineRootElement,
} from "@virgultum/core/runtime/inline";
import { Slice } from "@virgultum/core/store";
import {
  bundledLanguagesInfo,
  type ThemedToken,
} from "../../syntax-highlighter/index";

import { CodeBlockConfigExtension } from "./code-block-config";
import { CodeBlockInlineManagerExtension } from "./code-block-inline";
import { CodeBlockHighlighter } from "./code-block-service";
import { CodeBlockPreviewIdentifier } from "./code-preview-extension";
import { codeBlockStyles } from "./styles";

export class CodeBlockComponent extends NativeContainerBlock<CodeBlockModel> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  protected readonly blockStyles = codeBlockStyles;

  private readonly _localPreview$ = signal<boolean | null>(null);

  preview$: Signal<boolean> = computed(() => {
    const modelPreview = !!this.model.props.preview$.value;
    if (this.store.readonly) {
      return this._localPreview$.value ?? modelPreview;
    }
    return modelPreview;
  });

  highlightTokens$: Signal<ThemedToken[][]> = signal([]);

  languageName$: Signal<string> = computed(() => {
    const lang = this.model.props.language$.value;
    if (lang === null) {
      return "Plain Text";
    }

    const matchedInfo = this.langs.find((info) => info.id === lang);
    return matchedInfo ? matchedInfo.name : "Plain Text";
  });

  get inlineEditor() {
    const inlineRoot = this.querySelector<InlineRootElement>(
      `[${INLINE_ROOT_ATTR}]`,
    );
    return inlineRoot?.inlineEditor;
  }

  get inlineManager() {
    return this.std.get(CodeBlockInlineManagerExtension.identifier);
  }

  /** A key event can precede selectionchange; indentation must use the live range. */
  private get keyboardRange() {
    const editor = this.inlineEditor;
    const native = editor?.getNativeRange();
    return native ? editor?.toInlineRange(native) : editor?.getInlineRange();
  }

  /** Clipboard events can precede selectionchange; preserve object/multi-block selections. */
  syncClipboardRange() {
    const selection = this.host.selection;
    const native = this.inlineEditor?.getNativeRange();
    if (
      !selection.find(TextSelection) ||
      !native ||
      !this.host.contains(native.commonAncestorContainer) ||
      this.host.range.binding?.isComposing
    )
      return;
    const live = this.host.range.rangeToTextSelection(native);
    if (
      live?.from.blockId === this.blockId &&
      (!live.to || live.to.blockId === this.blockId)
    )
      selection.setGroup("note", [live]);
  }

  get notificationService() {
    return this.std.getOptional(NotificationProvider);
  }

  get readonly() {
    return this.store.readonly;
  }

  get langs() {
    return (
      this.std.getOptional(CodeBlockConfigExtension.identifier)?.langs ??
      bundledLanguagesInfo
    );
  }

  get highlighter() {
    return this.std.get(CodeBlockHighlighter);
  }

  override get topContenteditableElement() {
    if (this.std.get(DocModeProvider).getEditorMode() === "edgeless") {
      return this.closest<BlockComponent>(
        EDGELESS_TOP_CONTENTEDITABLE_SELECTOR,
      );
    }
    return this.rootComponent;
  }

  private _updateHighlightTokens() {
    const modelLang = this.model.props.language$.value;
    if (modelLang === null) {
      this.highlightTokens$.value = [];
      return;
    }

    const matchedInfo = this.langs.find(
      (info) =>
        info.id === modelLang ||
        info.name === modelLang ||
        info.aliases?.includes(modelLang),
    );

    if (matchedInfo) {
      this.model.props.language$.value = matchedInfo.id;
      const langImport = matchedInfo.import;
      const lang = matchedInfo.id;

      const highlighter = this.highlighter.highlighter$.value;
      const theme = this.highlighter.themeKey;
      if (!theme || !highlighter) {
        this.highlightTokens$.value = [];
        return;
      }

      noop(this.model.props.text.deltas$.value);
      const code = this.model.props.text.toString();

      const loadedLanguages = highlighter.getLoadedLanguages();
      if (!loadedLanguages.includes(lang)) {
        highlighter
          .loadLanguage(langImport)
          .then(() => {
            this.highlightTokens$.value = highlighter.codeToTokensBase(code, {
              lang,
              theme,
            });
          })
          .catch(console.error);
      } else {
        this.highlightTokens$.value = highlighter.codeToTokensBase(code, {
          lang,
          theme,
        });
      }
    } else {
      this.highlightTokens$.value = [];
      // clear language if not found
      this.model.props.language$.value = null;
    }
  }

  private bindEditing() {
    // set highlight options getter used by "exportToHtml"
    this.disposables.add(
      effect(() => {
        this._updateHighlightTokens();
      }),
    );
    this.disposables.add(
      effect(() => {
        noop(this.highlightTokens$.value);
        this._richTextElement?.inlineEditor?.render();
      }),
    );

    const selectionManager = this.host.selection;
    for (const event of ["copy", "cut"] as const)
      this.handleEvent(event, () => this.syncClipboardRange());
    const INDENT_SYMBOL = "  ";
    const LINE_BREAK_SYMBOL = "\n";
    const allIndexOf = (
      text: string,
      symbol: string,
      start = 0,
      end = text.length,
    ) => {
      const indexArr: number[] = [];
      let i = start;

      while (i < end) {
        const index = text.indexOf(symbol, i);
        if (index === -1 || index > end) {
          break;
        }
        indexArr.push(index);
        i = index + 1;
      }
      return indexArr;
    };

    // TODO: move to service for better performance
    this.bindHotKey({
      Backspace: (ctx) => {
        const event = ctx.get("defaultState").event;
        const textSelection = selectionManager.find(TextSelection);
        if (!textSelection) {
          event.preventDefault();
          return;
        }

        const from = textSelection.from;

        if (from.index === 0 && from.length === 0) {
          event.preventDefault();
          selectionManager.setGroup("note", [
            selectionManager.create(BlockSelection, { blockId: this.blockId }),
          ]);
          return true;
        }

        const inlineEditor = this.inlineEditor;
        const inlineRange = inlineEditor?.getInlineRange();
        if (!inlineRange || !inlineEditor) return;
        const left = inlineEditor.yText.toString()[inlineRange.index - 1];
        const right = inlineEditor.yText.toString()[inlineRange.index];
        const leftBrackets = BRACKET_PAIRS.map((pair) => pair.left);
        if (BRACKET_PAIRS[leftBrackets.indexOf(left)]?.right === right) {
          const index = inlineRange.index - 1;
          inlineEditor.deleteText({
            index: index,
            length: 2,
          });
          inlineEditor.setInlineRange({
            index: index,
            length: 0,
          });
          event.preventDefault();
          return true;
        }

        return;
      },
      Tab: (ctx) => {
        if (this.store.readonly) return;
        const state = ctx.get("keyboardState");
        const event = state.raw;
        const inlineEditor = this.inlineEditor;
        if (!inlineEditor) return;
        const inlineRange = this.keyboardRange;
        if (inlineRange) {
          event.stopPropagation();
          event.preventDefault();

          const text = this.inlineEditor.yText.toString();
          const index = text.lastIndexOf(
            LINE_BREAK_SYMBOL,
            inlineRange.index - 1,
          );
          const indexArr = allIndexOf(
            text,
            LINE_BREAK_SYMBOL,
            inlineRange.index,
            inlineRange.index + inlineRange.length,
          )
            .map((i) => i + 1)
            .reverse();
          if (index !== -1) {
            indexArr.push(index + 1);
          } else {
            indexArr.push(0);
          }
          indexArr.forEach((i) => {
            if (!this.inlineEditor) return;
            this.inlineEditor.insertText(
              {
                index: i,
                length: 0,
              },
              INDENT_SYMBOL,
            );
          });
          this.inlineEditor.setInlineRange({
            index: inlineRange.index + 2,
            length:
              inlineRange.length + (indexArr.length - 1) * INDENT_SYMBOL.length,
          });

          return true;
        }

        return;
      },
      "Shift-Tab": (ctx) => {
        if (this.store.readonly) return;
        const state = ctx.get("keyboardState");
        const event = state.raw;
        const inlineEditor = this.inlineEditor;
        if (!inlineEditor) return;
        const inlineRange = this.keyboardRange;
        if (inlineRange) {
          event.stopPropagation();
          event.preventDefault();

          const text = this.inlineEditor.yText.toString();
          const index = text.lastIndexOf(
            LINE_BREAK_SYMBOL,
            inlineRange.index - 1,
          );
          let indexArr = allIndexOf(
            text,
            LINE_BREAK_SYMBOL,
            inlineRange.index,
            inlineRange.index + inlineRange.length,
          )
            .map((i) => i + 1)
            .reverse();
          if (index !== -1) {
            indexArr.push(index + 1);
          } else {
            indexArr.push(0);
          }
          indexArr = indexArr.filter(
            (i) => text.slice(i, i + 2) === INDENT_SYMBOL,
          );
          indexArr.forEach((i) => {
            if (!this.inlineEditor) return;
            this.inlineEditor.deleteText({
              index: i,
              length: 2,
            });
          });
          if (indexArr.length > 0) {
            this.inlineEditor.setInlineRange({
              index:
                inlineRange.index -
                (indexArr[indexArr.length - 1] < inlineRange.index ? 2 : 0),
              length:
                inlineRange.length -
                (indexArr.length - 1) * INDENT_SYMBOL.length,
            });
          }

          return true;
        }

        return;
      },
      "Control-d": () => {
        if (!IS_MAC) return;
        return true;
      },
      Delete: () => {
        return;
      },
      Enter: () => {
        this.store.captureSync();
        return true;
      },
      "Mod-Enter": () => {
        const { model, std } = this;
        if (!model || !std) return;
        const inlineEditor = this.inlineEditor;
        const inlineRange = inlineEditor?.getInlineRange();
        if (!inlineRange || !inlineEditor) return;
        const isEnd = model.props.text.length === inlineRange.index;
        if (!isEnd) return;
        const parent = this.store.getParent(model);
        if (!parent) return;
        const index = parent.children.indexOf(model);
        if (index === -1) return;
        const id = this.store.addBlock(
          "myoxus:paragraph",
          {},
          parent,
          index + 1,
        );
        focusTextModel(std, id);
        return true;
      },
    });
  }

  copyCode() {
    const model = this.model;
    const slice = Slice.fromModels(model.store, [model]);
    this.std.clipboard
      .copySlice(slice)
      .then(() => {
        this.notificationService?.toast(
          this._text(
            editorMessage("Copied to clipboard", "Copied to clipboard"),
          ),
        );
      })
      .catch((e) => {
        this.notificationService?.toast(
          this._text(
            editorMessage(
              "com.myoxus.editor.clipboard.copy-failed",
              "Copy failed. Please try again.",
            ),
          ),
        );
        console.error(e);
      });
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  private get _richTextElement() {
    return this.querySelector<RichText>("rich-text");
  }
  get captionEditor() {
    return this.querySelector<BlockCaptionEditor>("block-caption-editor");
  }
  override get updateComplete() {
    return Promise.all([
      super.updateComplete,
      this._richTextElement?.updateComplete,
    ]).then(([complete]) => complete);
  }

  protected mountBody() {
    const doc = this.ownerDocument;
    const container = doc.createElement("div");
    container.className = "myoxus-code-block-container";
    container.classList.toggle("mobile", IS_MOBILE);
    const input = doc.createElement("rich-text");
    input.inlineEventSource = this.topContenteditableElement ?? undefined;
    input.undoManager = this.store.history.undoManager;
    input.attributesSchema = this.inlineManager.getSchema();
    input.attributeRenderer = this.inlineManager.getRenderer();
    input.inlineRangeProvider = getInlineRangeProvider(this) ?? undefined;
    input.enableClipboard = false;
    input.enableUndoRedo = false;
    input.verticalScrollContainerGetter = () => getViewportElement(this.host);
    input.lineNumbers = true;
    const preview = doc.createElement("div");
    preview.className = "myoxus-code-block-preview";
    preview.contentEditable = "false";
    container.append(input, preview);
    const frame = selectionFrame(this, container, true);
    frame.style.margin = "18px 0";
    const caption = doc.createElement("block-caption-editor");
    caption.model = this.model;
    caption.std = this.std;
    container.after(caption);
    const config = this.std.getOptional(CodeBlockConfigExtension.identifier);
    this.disposables.add(
      effect(() => {
        const props = this.model.props;
        input.yText = props.text$.value.yText;
        input.readonly = this.store.readonly;
        input.wrapText = props.wrap$.value;
        container.classList.toggle("wrap", input.wrapText);
        container.classList.toggle(
          "highlight-comment",
          this.isCommentHighlighted,
        );
        container.classList.toggle(
          "disable-line-numbers",
          config?.showLineNumbers === false ||
            props.lineNumber$?.value === false,
        );
      }),
    );
    this.disposables.add(
      effect(() => {
        const context =
          this.preview$.value &&
          this.std.getOptional(
            CodeBlockPreviewIdentifier(this.model.props.language$.value ?? ""),
          );
        input.style.display = context ? "none" : "";
        preview.style.display = context ? "" : "none";
        if (context) return context.mount(preview, this.model, this);
        return;
      }),
    );
    this.append(frame);
    this.bindEditing();
    this.mountBlockWidgets(container);
    return null;
  }

  setWrap(wrap: boolean) {
    this.store.updateBlock(this.model, { wrap });
  }

  setPreviewState(preview: boolean) {
    if (this.store.readonly) {
      this._localPreview$.value = preview;
    } else {
      this.store.updateBlock(this.model, { preview });
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-code": CodeBlockComponent;
  }
}
