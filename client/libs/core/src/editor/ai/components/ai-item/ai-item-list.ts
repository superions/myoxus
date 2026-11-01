import { flip, offset } from "@floating-ui/dom";
import { createLitPortal } from "@virgultum/editor/components/portal";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import {
  EditorHost,
  PropTypes,
  requiredProperties,
} from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { mantineLengthPx } from "../../_common/mantine-length";
import type { AIItem } from "./ai-item";
import type { AIItemConfig, AIItemGroupConfig } from "./types";

@requiredProperties({ host: PropTypes.instanceOf(EditorHost) })
export class AIItemList extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
      width: 100%;
      user-select: none;
    }
    .group-name {
      display: flex;
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        calc(
          var(--item-padding, ${unsafeCSSValue("var(--mantine-spacing-sm)")}) +
            ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        );
      align-items: center;
      color: var(--myoxus-text-secondary-color);
      text-align: justify;
      width: 100%;
      box-sizing: border-box;
    }

    ${fontXSStyle(".group-name")}
  `;

  private _abortController: AbortController | null = null;

  private _activeSubMenuItem: AIItemConfig | null = null;

  private readonly _closeSubMenu = () => {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this._activeSubMenuItem = null;
  };

  private readonly _itemClassName = (item: AIItemConfig) => {
    return "ai-item-" + item.name.split(" ").join("-").toLocaleLowerCase();
  };

  private readonly _openSubMenu = (item: AIItemConfig) => {
    if (!item.subItem || item.subItem.length === 0) {
      this._closeSubMenu();
      return;
    }

    if (item === this._activeSubMenuItem) {
      return;
    }

    const aiItem = this.shadowRoot?.querySelector(
      `.${this._itemClassName(item)}`,
    ) as AIItem | null;
    if (!aiItem || !aiItem.menuItem) return;

    this._closeSubMenu();
    this._activeSubMenuItem = item;
    this._abortController = new AbortController();
    this._abortController.signal.addEventListener("abort", () => {
      this._closeSubMenu();
    });

    const aiItemContainer = aiItem.menuItem;
    const subMenuOffset = {
      mainAxis:
        item.subItemOffset?.[0] ??
        mantineLengthPx(this, "--mantine-spacing-md"),
      crossAxis:
        item.subItemOffset?.[1] ??
        -mantineLengthPx(
          this,
          "--mantine-spacing-2xl",
          "--mantine-spacing-xl",
          "--mantine-spacing-xs",
        ),
    };

    createLitPortal({
      template: html`<ai-sub-item-list
        data-testid=${item.testId ? item.testId + "-menu" : ""}
        .item=${item}
        .host=${this.host}
        .onClick=${this.onClick}
        .abortController=${this._abortController}
      ></ai-sub-item-list>`,
      positionStrategy: "absolute",
      computePosition: {
        referenceElement: aiItemContainer,
        placement: "right-start",
        middleware: [flip(), offset(subMenuOffset)],
        autoUpdate: true,
      },
      abortController: this._abortController,
      closeOnClickAway: true,
    });
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._closeSubMenu();
  }

  override render() {
    return html`${repeat(this.groups, (group) => {
      return html`
        ${
          group.name
            ? html`<div class="group-name">
                ${group.name.toLocaleUpperCase()}
              </div>`
            : nothing
        }
        ${repeat(
          group.items,
          (item) => item.name,
          (item) =>
            html`<ai-item
              .onClick=${this.onClick}
              .item=${item}
              .host=${this.host}
              class=${this._itemClassName(item)}
              @mouseenter=${() => this._openSubMenu(item)}
            ></ai-item>`,
        )}
      `;
    })}`;
  }

  @property({ attribute: false })
  accessor groups: AIItemGroupConfig[] = [];

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor onClick: (() => void) | undefined = undefined;

  @property({ attribute: "data-testid", reflect: true })
  accessor testId = "ai-item-list";
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-item-list": AIItemList;
  }
}
