import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { css, html, LitElement } from "lit";

export class AIPanelDivider extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      align-self: stretch;
      width: 100%;
    }
    .divider {
      height: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")};
      background: var(--myoxus-border-color);
      width: 100%;
    }
  `;

  override render() {
    return html`<div class="divider"></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-panel-divider": AIPanelDivider;
  }
}
