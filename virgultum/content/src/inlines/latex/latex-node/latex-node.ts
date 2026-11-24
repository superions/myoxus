import { renderEquation } from "../render-equation";
import { effect, signal } from "@preact/signals-core";
import { openEquationEditor } from "./equation-session";
import { cssVar } from "@myoxus/theme";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import {
  type BlockComponent,
  type BlockStdScope,
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import {
  type InlineEditor,
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/core/runtime/inline";
import type { DeltaInsert } from "@virgultum/core/store";
export class MyoxusLatexNode extends NativeViewElement {
  private static readonly styles = `
    myoxus-latex-node {
      display: inline-block;
    }

    myoxus-latex-node .myoxus-latex {
      white-space: nowrap;
      word-break: break-word;
      color: ${cssVar("textPrimaryColor")};
      fill: var(--myoxus-icon-color);
      border-radius: 4px;
      text-decoration: none;
      cursor: pointer;
      user-select: none;
      padding: 1px 2px 1px 0;
      display: grid;
      grid-template-columns: auto 0;
      place-items: center;
      padding: 0 4px;
      margin: 0 2px;
    }
    myoxus-latex-node .myoxus-latex:hover {
      background: ${cssVar("hoverColor")};
    }
    myoxus-latex-node .myoxus-latex[data-selected="true"] {
      background: ${cssVar("hoverColor")};
    }

    myoxus-latex-node .error-placeholder {
      display: flex;
      padding: 2px 4px;
      justify-content: center;
      align-items: flex-start;
      gap: 10px;

      border-radius: 4px;
      background: ${cssVar("tagRed")};

      color: ${cssVar("textHighlightForegroundRed")};
      font-family: Inter;
      font-size: 12px;
      font-weight: 500;
      line-height: normal;
    }

    myoxus-latex-node .placeholder {
      display: flex;
      padding: 2px 4px;
      justify-content: center;
      align-items: flex-start;

      border-radius: 4px;
      background: ${cssVar("backgroundSecondaryColor")};

      color: ${cssVar("textSecondaryColor")};
      font-family: Inter;
      font-size: 12px;
      font-weight: 500;
      line-height: normal;
    }
  `;

  private _editorAbortController: AbortController | null = null;

  readonly latexEditorSignal = signal("");

  get deltaLatex() {
    return this.delta.attributes?.latex ?? "";
  }

  private stopRendering?: () => void;
  private clickEquation = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.readonly) this.toggleEditor();
  };

  connectedCallback() {
    installEditorStyles(this, MyoxusLatexNode.styles);
    const doc = this.ownerDocument;
    const wrapper = doc.createElement("span");
    wrapper.className = "myoxus-latex";
    wrapper.dataset.selected = String(this.selected);
    const preview = doc.createElement("div");
    preview.className = "latex-container";
    const caret = doc.createElement("v-text");
    caret.str = ZERO_WIDTH_FOR_EMBED_NODE;
    wrapper.append(preview, caret);
    this.replaceChildren(wrapper);
    this.latexEditorSignal.value = this.deltaLatex;
    this.stopRendering = effect(() =>
      renderEquation(this.std, preview, this.latexEditorSignal.value, false),
    );
    this.addEventListener("click", this.clickEquation);
  }
  disconnectedCallback() {
    this.stopRendering?.();
    this.removeEventListener("click", this.clickEquation);
    this._editorAbortController?.abort();
  }

  toggleEditor() {
    const blockComponent = this.closest<BlockComponent>("[data-block-id]");
    if (!blockComponent) return;

    this._editorAbortController?.abort();
    this._editorAbortController = new AbortController();
    const originalLatex = this.deltaLatex;

    blockComponent.selection.setGroup("note", []);

    openEquationEditor(
      this.std,
      this,
      this.latexEditorSignal,
      this._editorAbortController,
    );

    this._editorAbortController.signal.addEventListener(
      "abort",
      () => {
        if (
          !this.isConnected ||
          this.readonly ||
          this.deltaLatex !== originalLatex
        ) {
          this.latexEditorSignal.value = this.deltaLatex;
          return;
        }
        const latex = this.latexEditorSignal.peek();
        if (latex !== this.deltaLatex) {
          this.editor.formatText(
            {
              index: this.startOffset,
              length: this.endOffset - this.startOffset,
            },
            { latex },
          );
        }
        this.std.store.captureSync();
        this.editor.setInlineRange({ index: this.endOffset, length: 0 });
      },
      { once: true },
    );
  }

  get readonly() {
    return this.std.store.readonly;
  }

  private sourceDelta: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  };
  get delta() {
    return this.sourceDelta;
  }
  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    const previous = this.deltaLatex;
    this.sourceDelta = value;
    if (previous !== this.deltaLatex) {
      // Undo or a remote edit takes precedence over the open source draft.
      this._editorAbortController?.abort();
      this.latexEditorSignal.value = this.deltaLatex;
    }
  }

  editor!: InlineEditor<MyoxusTextAttributes>;
  endOffset!: number;
  private active = false;
  get selected() {
    return this.active;
  }
  set selected(value: boolean) {
    this.active = value;
    this.firstElementChild?.setAttribute("data-selected", String(value));
  }
  startOffset!: number;
  std!: BlockStdScope;
}
