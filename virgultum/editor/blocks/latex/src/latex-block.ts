import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { effect } from "@preact/signals-core";
import { selectBlock } from "@virgultum/block-note";
import { CaptionedBlockComponent } from "@virgultum/components/caption";
import { openEquationEditor } from "@virgultum/inline-latex";
import type { LatexBlockModel } from "@virgultum/model";
import { BlockSelection } from "@virgultum/std";
import katex from "katex";
import { html, render } from "lit";
import { query } from "lit/decorators.js";

import { latexBlockStyles } from "./styles.js";

export class LatexBlockComponent extends CaptionedBlockComponent<LatexBlockModel> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = latexBlockStyles;

  private _editorAbortController: AbortController | null = null;

  get isBlockSelected() {
    return this.selection
      .filter(BlockSelection)
      .some((selection) => selection.blockId === this.model.id);
  }

  override firstUpdated(props: Map<string, unknown>) {
    super.firstUpdated(props);

    const { disposables } = this;

    disposables.add(() => {
      this._editorAbortController?.abort();
    });

    const katexContainer = this._katexContainer;
    if (!katexContainer) return;

    disposables.add(
      effect(() => {
        const latex = this.model.props.latex$.value;

        katexContainer.replaceChildren();
        // @ts-expect-error lit hack won't fix
        delete katexContainer["_$litPart$"];

        if (latex.length === 0) {
          render(
            html`<span class="latex-block-empty-placeholder"
              >${this._text(editorMessage("com.myoxus.editor.slash.equation", "Equation"))}</span
            >`,
            katexContainer,
          );
        } else {
          try {
            katex.render(latex, katexContainer, {
              displayMode: true,
            });
          } catch {
            katexContainer.replaceChildren();
            // @ts-expect-error lit hack won't fix
            delete katexContainer["_$litPart$"];
            render(
              html`<span class="latex-block-error-placeholder"
                >${this._text(editorMessage("com.myoxus.editor.equation.invalid", "Invalid equation"))}</span
              >`,
              katexContainer,
            );
          }
        }
      }),
    );
  }

  private _handleClick() {
    if (this.store.readonly) return;

    if (this.isBlockSelected) {
      this.toggleEditor();
    } else {
      this.selectBlock();
    }
  }

  override renderBlock() {
    return html`
      <div
        contenteditable="false"
        class="latex-block-container"
        @click=${this._handleClick}
      >
        <div class="katex"></div>
      </div>
    `;
  }

  selectBlock() {
    this.host.command.exec(selectBlock, {
      focusBlock: this,
    });
  }

  toggleEditor() {
    const katexContainer = this._katexContainer;
    if (!katexContainer) return;

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

  @query(".latex-block-container")
  private accessor _katexContainer!: HTMLDivElement;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-latex": LatexBlockComponent;
  }
}
