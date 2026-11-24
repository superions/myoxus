import { type Signal, signal } from "@preact/signals-core";

import { ColorScheme } from "@virgultum/core/models";
import type { RichText } from "../../../rich-text/index";
import { ThemeProvider } from "@virgultum/core/services";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import { type BlockStdScope, NativeViewElement } from "@virgultum/core/runtime";
import { InlineManagerExtension } from "@virgultum/core/runtime/inline";
import {
  codeToTokensBase,
  type ThemedToken,
} from "../../../syntax-highlighter/index";
import * as Y from "yjs";

import { LatexEditorUnitSpecExtension } from "../inline-spec";

export const LatexEditorInlineManagerExtension =
  InlineManagerExtension<MyoxusTextAttributes>({
    id: "latex-inline-editor",
    enableMarkdown: false,
    specs: [LatexEditorUnitSpecExtension.identifier],
  });

export class LatexSourceEditor extends NativeViewElement {
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

  private release?: () => void;

  connectedCallback() {
    const doc = new Y.Doc();
    const text = doc.getText("latex");
    this.yText = text;
    text.insert(0, this.latexSignal.value);
    const input = this.ownerDocument.createElement("rich-text");
    input.yText = text;
    input.attributesSchema = this.inlineManager.getSchema();
    input.attributeRenderer = this.inlineManager.getRenderer();
    input.verticalScrollContainerGetter = this._getVerticalScrollContainer;
    const onText = () => {
      const value = text.toString();
      if (this.canEdit()) this.change(value);
      this._updateHighlightTokens(value);
    };
    text.observe(onText);
    const stopTheme = this.std
      .get(ThemeProvider)
      .theme$.subscribe(() => this._updateHighlightTokens(text.toString()));
    this.replaceChildren(input);
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    input.updateComplete
      .then(() => {
        if (input.isConnected)
          focusTimer = setTimeout(() => input.inlineEditor?.focusEnd());
      })
      .catch(console.error);
    this.release = () => {
      clearTimeout(focusTimer);
      stopTheme();
      text.unobserve(onText);
      ++this._highlightVersion;
      input.remove();
      doc.destroy();
    };
  }

  disconnectedCallback() {
    this.release?.();
    this.release = undefined;
  }
  canEdit: () => boolean = () => false;
  change!: (value: string) => void;
  latexSignal!: Signal<string>;
  std!: BlockStdScope;
}
