import { WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { html } from "lit-html";

export const TOGGLE_BUTTON_PARENT_CLASS = "virgultum-toggle-button-parent";

export class ToggleButton extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .toggle-icon {
      display: flex;
      align-items: start;
      justify-content: start;
      position: absolute;
      width: 16px;
      height: 16px;
      top: calc((1em - 16px) / 2 + 5px);
      left: 0;
      transform: translateX(-100%);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s ease-in-out;
    }

    .toggle-icon:hover {
      background: var(--myoxus-hover-color);
    }

    .toggle-icon[data-collapsed="true"] {
      opacity: 1;
    }

    .${unsafeCSS(TOGGLE_BUTTON_PARENT_CLASS)}:hover .toggle-icon {
      opacity: 1;
    }

    .with-drag-handle .toggle-icon {
      opacity: 1;
    }
    .with-drag-handle .myoxus-block-children-container .toggle-icon {
      opacity: 0;
    }

    .myoxus-disclosure-triangle {
      width: var(--mantine-spacing-md);
      height: var(--mantine-spacing-md);
      color: ${unsafeCSSVar("iconColor")};
      transition: transform 0.2s ease-in-out;
    }

    .myoxus-disclosure-triangle[data-collapsed="false"] {
      transform: rotate(90deg);
    }
  `;

  private _disclosureTriangle() {
    return html`
      <svg
        class="myoxus-disclosure-triangle"
        data-collapsed=${this.collapsed}
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 16 16"
      >
        <path d="M5.5 3.5L10.5 8L5.5 12.5Z" fill="currentColor"></path>
      </svg>
    `;
  }

  override render() {
    return html`
      <div
        contenteditable="false"
        class="toggle-icon"
        data-collapsed=${this.collapsed}
        @click=${() => this.updateCollapsed(!this.collapsed)}
      >
        ${this._disclosureTriangle()}
      </div>
    `;
  }

  @property({ attribute: false })
  accessor collapsed!: boolean;

  @property({ attribute: false })
  accessor updateCollapsed!: (collapsed: boolean) => void;
}

declare global {
  interface HTMLElementTagNameMap {
    "virgultum-toggle-button": ToggleButton;
  }
}
