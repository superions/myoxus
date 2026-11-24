import { renderEquation } from "../../inlines/latex/render-equation";
import { effect } from "@preact/signals-core";
import { selectBlock } from "@virgultum/core/commands";
import { selectionFrame } from "../../caption/selection-frame";
import { openEquationEditor } from "../../inlines/latex/index";
import type { LatexBlockModel } from "@virgultum/core/models";
import { BlockSelection, NativeContainerBlock } from "@virgultum/core/runtime";

import { latexBlockStyles } from "./styles";

export class LatexBlockComponent extends NativeContainerBlock<LatexBlockModel> {
  protected readonly blockStyles = latexBlockStyles;

  private _editorAbortController: AbortController | null = null;

  get isBlockSelected() {
    return this.selection
      .filter(BlockSelection)
      .some((selection) => selection.blockId === this.model.id);
  }

  protected mountBody() {
    const container = this.ownerDocument.createElement("div");
    container.className = "latex-block-container";
    container.contentEditable = "false";
    container.addEventListener("click", () => this._handleClick());
    this.append(selectionFrame(this, container));
    this.disposables.add(() => this._editorAbortController?.abort());
    this.disposables.add(
      effect(() => {
        const latex = this.model.props.latex$.value;
        renderEquation(this.std, container, latex, true);
      }),
    );
    return null;
  }

  private _handleClick() {
    if (this.store.readonly) return;

    if (this.isBlockSelected) {
      this.toggleEditor();
    } else {
      this.selectBlock();
    }
  }

  selectBlock() {
    this.host.command.exec(selectBlock, {
      focusBlock: this,
    });
  }

  toggleEditor() {
    if (!this.isConnected || this.store.readonly) return;
    this._editorAbortController?.abort();
    this._editorAbortController = new AbortController();

    this.selection.setGroup("note", []);
    this.store.captureSync();
    this._editorAbortController.signal.addEventListener(
      "abort",
      () => this.store.captureSync(),
      { once: true },
    );

    openEquationEditor(
      this.std,
      this,
      this.model.props.latex$,
      this._editorAbortController,
      "bottom",
      // Model signals project values; document commands supply the tracked history origin.
      (latex) => this.store.updateBlock(this.model, { latex }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-latex": LatexBlockComponent;
  }
}
