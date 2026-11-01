import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";
import { SignalWatcher } from "@virgultum/global/lit";
import type { MyoxusTextStyleAttributes } from "@virgultum/shared/types";
import { PropTypes, requiredProperties } from "@virgultum/std";
import { LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { html } from "lit-html";
import { repeat } from "lit-html/directives/repeat.js";

import { EditorChevronDown } from "../toolbar";

const colors = [
  "default",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "grey",
] as const;

const colorLabels = {
  red: editorMessage("com.myoxus.editor.table.color.red", "Red"),
  orange: editorMessage("com.myoxus.editor.table.color.orange", "Orange"),
  yellow: editorMessage("com.myoxus.editor.table.color.yellow", "Yellow"),
  green: editorMessage("com.myoxus.editor.table.color.green", "Green"),
  teal: editorMessage("com.myoxus.editor.table.color.teal", "Teal"),
  blue: editorMessage("com.myoxus.editor.table.color.blue", "Blue"),
  purple: editorMessage("com.myoxus.editor.table.color.purple", "Purple"),
  grey: editorMessage("com.myoxus.editor.table.color.grey", "Grey"),
};

export type HighlightType = Pick<
  MyoxusTextStyleAttributes,
  "color" | "background"
>;

// TODO(@fundon): these recent settings should be added to the dropdown menu
// tests/blocksutie/e2e/format-bar.spec.ts#253
//
// let latestHighlightColor: string | null = null;
// let latestHighlightType: HighlightType = 'background';

@requiredProperties({
  updateHighlight: PropTypes.instanceOf(Function),
})
export class HighlightDropdownMenu extends SignalWatcher(LitElement) {
  @property({ attribute: false })
  accessor updateHighlight!: (styles: HighlightType) => void;

  @state()
  private accessor _latestHighlight: HighlightType = {};

  private readonly _update = (style: HighlightType) => {
    this._latestHighlight = { ...this._latestHighlight, ...style };
    this.updateHighlight(style);
  };

  @property({ attribute: false })
  accessor i18n: EditorI18nService | undefined;

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(message, this.i18n);
  }

  override render() {
    const prefix = "--myoxus-text-highlight";

    return html`
      <editor-menu-button
        .contentPadding="${"8px"}"
        .button=${html`
          <editor-icon-button
            aria-label=${this._text(editorMessage("com.myoxus.editor.highlight", "Highlight"))}
            .tooltip="${this._text(editorMessage("com.myoxus.editor.highlight", "Highlight"))}"
          >
            <myoxus-highlight-duotone-icon
              style=${styleMap({
                "--color":
                  this._latestHighlight.color ??
                  "var(--myoxus-text-primary-color)",
                "--background":
                  this._latestHighlight.background ?? "transparent",
              })}
            ></myoxus-highlight-duotone-icon>
            ${EditorChevronDown}
          </editor-icon-button>
        `}
      >
        <div data-size="large" data-orientation="vertical">
          <div class="highlight-heading">
            ${this._text(editorMessage("com.myoxus.editor.keyboard.background", "Background"))}
          </div>
          ${repeat(colors, (color) => {
            const isDefault = color === "default";
            const value = isDefault ? null : `var(${prefix}-${color})`;
            return html`
              <editor-menu-action
                data-testid="background-${color}"
                @click=${() => this._update({ background: value })}
              >
                <myoxus-text-duotone-icon
                  style=${styleMap({
                    "--color": "var(--myoxus-text-primary-color)",
                    "--background": value ?? "transparent",
                  })}
                ></myoxus-text-duotone-icon>

                <span class="label capitalize"
                  >${isDefault ? this._text(editorMessage("com.myoxus.editor.callout.background.default", "Default background")) : this._text(colorLabels[color])}</span
                >
              </editor-menu-action>
            `;
          })}

          <div class="highlight-heading">
            ${this._text(editorMessage("com.myoxus.editor.keyboard.color", "Color"))}
          </div>
          ${repeat(colors, (color) => {
            const isDefault = color === "default";
            const value = isDefault
              ? null
              : `var(${prefix}-foreground-${color})`;
            return html`
              <editor-menu-action
                data-testid="foreground-${color}"
                @click=${() => this._update({ color: value })}
              >
                <myoxus-text-duotone-icon
                  style=${styleMap({
                    "--color": value ?? "var(--myoxus-text-primary-color)",
                  })}
                ></myoxus-text-duotone-icon>
                <span class="label capitalize"
                  >${isDefault ? this._text(editorMessage("com.myoxus.editor.keyboard.default-color", "Default Color")) : this._text(colorLabels[color])}</span
                >
              </editor-menu-action>
            `;
          })}
        </div>
      </editor-menu-button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-highlight-dropdown-menu": HighlightDropdownMenu;
  }
}
