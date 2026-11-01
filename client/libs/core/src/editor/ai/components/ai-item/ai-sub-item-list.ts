import { EnterIcon } from "@virgultum/editor/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { stopPropagation } from "@virgultum/editor/shared/utils";
import {
  EditorHost,
  PropTypes,
  requiredProperties,
} from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { menuItemStyles } from "./styles";
import type { AIItemConfig, AISubItemConfig } from "./types";

@requiredProperties({
  host: PropTypes.instanceOf(EditorHost),
  item: PropTypes.object,
})
export class AISubItemList extends WithDisposable(LitElement) {
  static override styles = css`
    .ai-sub-menu {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      min-width: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          6
      );
      max-height: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          8
      );
      overflow-y: auto;
      background: var(--myoxus-background-overlay-panel-color);
      box-shadow: var(--myoxus-shadow-2);
      border-radius: ${unsafeCSSValue("var(--mantine-radius-md)")};
      z-index: var(--myoxus-z-index-popover);
      color: var(--myoxus-text-primary-color);
      text-align: justify;
      user-select: none;
    }
    ${fontSMStyle(".ai-sub-menu")}
    ${menuItemStyles}
  `;

  private readonly _handleClick = (subItem: AISubItemConfig) => {
    this.onClick?.();
    if (subItem.handler) {
      // TODO: add parameters to ai handler
      subItem.handler(this.host);
    }
    this.abortController.abort();
  };

  override connectedCallback() {
    super.connectedCallback();

    this.disposables.addFromEvent(this, "pointerdown", stopPropagation);
  }

  override render() {
    if (!this.item.subItem || this.item.subItem.length <= 0) return nothing;
    return html`<div class="ai-sub-menu">
      ${repeat(
        this.item.subItem,
        (subItem) => subItem.type,
        (subItem) =>
          html`<div
            data-testid=${subItem.testId}
            class="menu-item"
            @click=${() => this._handleClick(subItem)}
          >
            <div class="item-name">${subItem.type}</div>
            <span class="enter-icon">${EnterIcon}</span>
          </div>`,
      )}
    </div>`;
  }

  @property({ attribute: false })
  accessor abortController: AbortController = new AbortController();

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor item!: AIItemConfig;

  @property({ attribute: false })
  accessor onClick: (() => void) | undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-sub-item-list": AISubItemList;
  }
}
