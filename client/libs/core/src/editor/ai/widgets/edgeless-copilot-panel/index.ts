import { WithDisposable } from "@virgultum/editor/global/lit";
import { scrollbarStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { on, stopPropagation } from "@virgultum/editor/shared/utils";
import type { EditorHost } from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";

import type { AIItemGroupConfig } from "../../components/ai-item/types";

export class EdgelessCopilotPanel extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      position: absolute;
      max-block-size: ${unsafeCSSValue(
        "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13)",
      )};
    }

    .edgeless-copilot-panel {
      box-sizing: border-box;
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")}
        ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        ${unsafeCSSValue("var(--mantine-spacing-sm)")}
        ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      min-inline-size: ${unsafeCSSValue(
        "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 7)",
      )};
      max-block-size: ${unsafeCSSValue(
        "calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 13)",
      )};
      overflow-y: auto;
      overscroll-behavior: contain;
      background: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      box-shadow: ${unsafeCSSVar("overlayPanelShadow")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      z-index: var(--myoxus-z-index-popover);
    }

    ${scrollbarStyle(".edgeless-copilot-panel")}
  `;

  private _getChain() {
    return this.host.std.command.chain();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._disposables.add(on(this, "wheel", stopPropagation));
    this._disposables.add(on(this, "pointerdown", stopPropagation));
  }

  hide() {
    this.remove();
  }

  override render() {
    const chain = this._getChain();
    const groups = this.groups.reduce((pre, group) => {
      const filtered = group.items.filter((item) =>
        item.showWhen?.(chain, "edgeless", this.host),
      );

      if (filtered.length > 0) pre.push({ ...group, items: filtered });

      return pre;
    }, [] as AIItemGroupConfig[]);

    if (groups.every((group) => group.items.length === 0)) return nothing;

    return html`
      <div class="edgeless-copilot-panel">
        <ai-item-list
          .onClick=${() => {
            this.onClick?.();
          }}
          .host=${this.host}
          .groups=${groups}
        ></ai-item-list>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor entry: "toolbar" | "selection" | undefined = undefined;

  @property({ attribute: false })
  accessor groups!: AIItemGroupConfig[];

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor onClick: (() => void) | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-copilot-panel": EdgelessCopilotPanel;
  }
}
