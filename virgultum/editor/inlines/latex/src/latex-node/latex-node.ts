import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { signal } from "@preact/signals-core";
import { createLitPortal } from "@virgultum/components/portal";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import {
  type BlockComponent,
  type BlockStdScope,
  ShadowlessElement,
} from "@virgultum/std";
import {
  type InlineEditor,
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/std/inline";
import type { DeltaInsert } from "@virgultum/store";
import katex from "katex";
import { css, html, render } from "lit";
import { property } from "lit/decorators.js";

export class MyoxusLatexNode extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    myoxus-latex-node {
      display: inline-block;
    }

    myoxus-latex-node .myoxus-latex {
      white-space: nowrap;
      word-break: break-word;
      color: ${unsafeCSSVar("textPrimaryColor")};
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
      background: ${unsafeCSSVar("hoverColor")};
    }
    myoxus-latex-node .myoxus-latex[data-selected="true"] {
      background: ${unsafeCSSVar("hoverColor")};
    }

    myoxus-latex-node .error-placeholder {
      display: flex;
      padding: 2px 4px;
      justify-content: center;
      align-items: flex-start;
      gap: 10px;

      border-radius: 4px;
      background: ${unsafeCSSVar("tagRed")};

      color: ${unsafeCSSVar("textHighlightForegroundRed")};
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
      background: ${unsafeCSSVar("backgroundSecondaryColor")};

      color: ${unsafeCSSVar("textSecondaryColor")};
      font-family: Inter;
      font-size: 12px;
      font-weight: 500;
      line-height: normal;
    }
  `;

  private _editorAbortController: AbortController | null = null;

  readonly latex$ = signal("");

  readonly latexEditorSignal = signal("");

  get deltaLatex() {
    return this.delta.attributes?.latex as string;
  }

  get latexContainer() {
    return this.querySelector<HTMLElement>(".latex-container");
  }

  override connectedCallback() {
    const result = super.connectedCallback();

    this.latex$.value = this.deltaLatex;
    this.latexEditorSignal.value = this.deltaLatex;

    this.disposables.add(
      this.latex$.subscribe((latex) => {
        this.latexEditorSignal.value = latex;
        if (latex !== this.deltaLatex) {
          this.editor.formatText(
            {
              index: this.startOffset,
              length: this.endOffset - this.startOffset,
            },
            {
              latex,
            },
          );
        }
      }),
    );

    this._editorAbortController?.abort();
    this._editorAbortController = new AbortController();
    this.disposables.add(() => {
      this._editorAbortController?.abort();
    });

    this.disposables.addFromEvent(this, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.readonly) {
        return;
      }
      this.toggleEditor();
    });

    return result;
  }

  override updated() {
    const latexContainer = this.latexContainer;
    if (!latexContainer) return;
    const latex = this.latexEditorSignal.value;
    latexContainer.replaceChildren();
    // @ts-expect-error lit hack won't fix
    delete latexContainer["_$litPart$"];
    if (latex.length === 0) {
      render(
        html`<span class="placeholder"
          >${this._text(editorMessage("com.myoxus.editor.slash.equation", "Equation"))}</span
        >`,
        latexContainer,
      );
    } else {
      try {
        katex.render(latex, latexContainer, { displayMode: false });
      } catch {
        render(
          html`<span class="error-placeholder"
            >${this._text(editorMessage("com.myoxus.editor.equation.invalid", "Invalid equation"))}</span
          >`,
          latexContainer,
        );
      }
    }
  }

  override render() {
    // Subscribe before the imperative KaTeX render in updated().
    void this.latexEditorSignal.value;
    void this.std.getOptional(EditorI18nProvider)?.locale$.value;
    return html`<span class="myoxus-latex" data-selected=${this.selected}
      ><div class="latex-container"></div>
      <v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text
    ></span>`;
  }

  toggleEditor() {
    const blockComponent = this.closest<BlockComponent>("[data-block-id]");
    if (!blockComponent) return;

    this._editorAbortController?.abort();
    this._editorAbortController = new AbortController();

    blockComponent.selection.setGroup("note", []);

    const { portal } = createLitPortal({
      template: html`<latex-editor-menu
        .std=${this.std}
        .latexSignal=${this.latexEditorSignal}
        .abortController=${this._editorAbortController}
      ></latex-editor-menu>`,
      container: blockComponent.host,
      computePosition: {
        referenceElement: this,
        placement: "bottom-start",
        autoUpdate: {
          animationFrame: true,
        },
      },
      closeOnClickAway: true,
      abortController: this._editorAbortController,
      shadowDom: false,
      portalStyles: {
        zIndex: "var(--myoxus-z-index-popover)",
      },
    });

    this._editorAbortController.signal.addEventListener(
      "abort",
      () => {
        portal.remove();
        const latex = this.latexEditorSignal.peek();
        this.latex$.value = latex;

        if (latex !== this.deltaLatex) {
          this.editor.formatText(
            {
              index: this.startOffset,
              length: this.endOffset - this.startOffset,
            },
            {
              latex,
            },
          );
          this.editor.setInlineRange({
            index: this.endOffset,
            length: 0,
          });
        }
      },
      { once: true },
    );
  }

  get readonly() {
    return this.std.store.readonly;
  }

  @property({ attribute: false })
  accessor delta: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  };

  @property({ attribute: false })
  accessor editor!: InlineEditor<MyoxusTextAttributes>;

  @property({ attribute: false })
  accessor endOffset!: number;

  @property({ attribute: false })
  accessor selected = false;

  @property({ attribute: false })
  accessor startOffset!: number;

  @property({ attribute: false })
  accessor std!: BlockStdScope;
}
