import { ArrowRightIcon, EnterIcon } from "@virgultum/editor/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import {
  EditorHost,
  PropTypes,
  requiredProperties,
} from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property, query } from "lit/decorators.js";

import { menuItemStyles } from "./styles";
import type { AIItemConfig } from "./types";

@requiredProperties({
  host: PropTypes.instanceOf(EditorHost),
  item: PropTypes.object,
})
export class AIItem extends WithDisposable(LitElement) {
  static override styles = css`
    ${menuItemStyles}
  `;

  override render() {
    const { item } = this;
    const className = item.name.split(" ").join("-").toLocaleLowerCase();
    const testId = item.testId;

    return html`<div
      data-testid=${testId}
      class="menu-item ${className}"
      @pointerdown=${(e: MouseEvent) => e.stopPropagation()}
      @click=${() => {
        this.onClick?.();
        if (typeof item.handler === "function") {
          item.handler(this.host);
        }
      }}
    >
      <span class="item-icon">${item.icon}</span>
      <div class="item-name">
        ${item.name}${
          item.beta ? html`<div class="item-beta">(Beta)</div>` : nothing
        }
      </div>
      ${
        item.subItem
          ? html`<span class="arrow-right-icon">${ArrowRightIcon}</span>`
          : html`<span class="enter-icon">${EnterIcon}</span>`
      }
    </div>`;
  }

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor item!: AIItemConfig;

  @query(".menu-item")
  accessor menuItem: HTMLDivElement | null = null;

  @property({ attribute: false })
  accessor onClick: (() => void) | undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-item": AIItem;
  }
}
