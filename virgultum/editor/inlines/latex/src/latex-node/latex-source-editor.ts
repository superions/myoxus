import { type Signal, signal } from "@preact/signals-core";
import { WithDisposable } from "@virgultum/global/lit";
import { ColorScheme } from "@virgultum/model";
import type { RichText } from "@virgultum/rich-text";
import { ThemeProvider } from "@virgultum/shared/services";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { type BlockStdScope, ShadowlessElement } from "@virgultum/std";
import { InlineManagerExtension } from "@virgultum/std/inline";
import { html } from "lit";
import { property } from "lit/decorators.js";
import {
  codeToTokensBase,
  type ThemedToken,
} from "@virgultum/components/syntax-highlighter";
import * as Y from "yjs";

import { LatexEditorUnitSpecExtension } from "../inline-spec";

export const LatexEditorInlineManagerExtension =
  InlineManagerExtension<MyoxusTextAttributes>({
    id: "latex-inline-editor",
    enableMarkdown: false,
    specs: [LatexEditorUnitSpecExtension.identifier],
  });

export class LatexSourceEditor extends WithDisposable(ShadowlessElement) {
  highlightTokens$: Signal<ThemedToken[][]> = signal([]);

  yText!: Y.Text;

  get inlineManager() {
    return this.std.get(LatexEditorInlineManagerExtension.identifier);
  }

  get richText() {
    return this.querySelector<RichText>("rich-text");
  }

  private readonly _getVerticalScrollContainer = () => {
    return this.closest<HTMLElement>("[data-equation-scroll]");
  };

  private _highlightVersion = 0;

  private _updateHighlightTokens(text: string) {
    const version = ++this._highlightVersion;
    const editorTheme = this.std.get(ThemeProvider).theme;
    const theme = editorTheme === ColorScheme.Dark ? "dark-plus" : "light-plus";

    codeToTokensBase(text, {
      lang: "latex",
      theme,
    })
      .then((token) => {
        if (this.isConnected && version === this._highlightVersion) {
          this.highlightTokens$.value = token;
          this.richText?.inlineEditor?.render();
        }
      })
      .catch(console.error);
  }

  override connectedCallback(): void {
    super.connectedCallback();

    const doc = new Y.Doc();
    this.yText = doc.getText("latex");
    this.yText.insert(0, this.latexSignal.value);

    const yTextObserver = () => {
      const text = this.yText.toString();
      if (this.canEdit()) this.change(text);

      this._updateHighlightTokens(text);
    };
    this.yText.observe(yTextObserver);
    this.disposables.add(() => {
      this.yText.unobserve(yTextObserver);
      ++this._highlightVersion;
      doc.destroy();
    });

    this.disposables.add(
      this.std.get(ThemeProvider).theme$.subscribe(() => {
        this._updateHighlightTokens(this.yText.toString());
      }),
    );

    this.updateComplete
      .then(async () => {
        await this.richText?.updateComplete;

        setTimeout(() => {
          this.richText?.inlineEditor?.focusEnd();
        });
      })
      .catch(console.error);
  }

  override render() {
    return html`<rich-text
      .yText=${this.yText}
      .attributesSchema=${this.inlineManager.getSchema()}
      .attributeRenderer=${this.inlineManager.getRenderer()}
      .verticalScrollContainerGetter=${this._getVerticalScrollContainer}
    ></rich-text>`;
  }

  @property({ attribute: false })
  accessor canEdit: () => boolean = () => false;

  @property({ attribute: false })
  accessor change!: (value: string) => void;

  @property({ attribute: false })
  accessor latexSignal!: Signal<string>;

  @property({ attribute: false })
  accessor std!: BlockStdScope;
}
