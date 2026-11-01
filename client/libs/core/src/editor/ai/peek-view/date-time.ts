import { i18nTime } from "@myoxus/i18n";
import { fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

export class DateTime extends LitElement {
  static override styles = css`
    :host {
      width: 100%;
    }
    .date-time-container {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .line {
      flex-grow: 1;
      height: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")};
      background-color: ${unsafeCSSVar("borderColor")};
    }
    .date-time {
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      text-align: center;
      color: ${unsafeCSSVar("textSecondaryColor")};
    }

    ${fontXSStyle(".date-time")}
  `;

  override render() {
    const date = i18nTime(this.date, {
      relative: {
        max: [1, "day"],
        accuracy: "minute",
        weekday: true,
      },
      absolute: {
        accuracy: "second",
      },
    });

    return html`<div class="date-time-container">
      <div class="line"></div>
      <div class="date-time">${date}</div>
      <div class="line"></div>
    </div>`;
  }

  @property({ attribute: false })
  accessor date!: string;
}

declare global {
  interface HTMLElementTagNameMap {
    "date-time": DateTime;
  }
}
