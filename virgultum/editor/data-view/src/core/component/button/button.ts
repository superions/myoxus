import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export class Button extends SignalWatcher(WithDisposable(ShadowlessElement)) {
  static override styles = css`
    data-view-component-button {
      border-radius: 4px;
      border: 1px solid ${unsafeCSSVar("borderColor")};
      display: flex;
      padding: 4px 8px;
      align-items: center;
      gap: 4px;
      font-size: 14px;
      font-weight: 400;
      line-height: 22px;
      color: ${unsafeCSSVar("textPrimaryColor")};
      cursor: pointer;
      transition:
        color 0.2s,
        background-color 0.2s,
        border-color 0.2s;
      white-space: nowrap;
    }

    data-view-component-button.border:hover,
    data-view-component-button.border.active {
      color: ${unsafeCSSVar("textEmphasisColor")};
      border-color: ${unsafeCSSVar("primaryColor")};
    }

    data-view-component-button.background:hover,
    data-view-component-button.background.active {
      background-color: ${unsafeCSSVar("hoverColor")};
    }

    .button-icon {
      font-size: 16px;
      display: flex;
      align-items: center;
      transition: color 0.2s;
      color: ${unsafeCSSVar("iconColor")};
    }

    data-view-component-button.border:hover .button-icon,
    data-view-component-button.border.active .button-icon {
      color: ${unsafeCSSVar("primaryColor")};
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add(this.hoverType);
    if (this.onClick) {
      this.disposables.addFromEvent(this, "click", this.onClick);
    }
  }

  override render() {
    return html`
      <div class="button-icon">${this.icon}</div>
      ${this.text}
      <div class="button-icon">${this.postfix}</div>
    `;
  }

  @property()
  accessor hoverType: "background" | "border" = "background";

  @property({ attribute: false })
  accessor icon: TemplateResult | undefined;

  @property({ attribute: false })
  accessor onClick: ((event: MouseEvent) => void) | undefined;

  @property({ attribute: false })
  accessor postfix: TemplateResult | string | undefined;

  @property({ attribute: false })
  accessor text: TemplateResult | string | undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "data-view-component-button": Button;
  }
}
