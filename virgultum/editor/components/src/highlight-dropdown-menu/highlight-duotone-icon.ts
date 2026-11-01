import { HighLightDuotoneIcon } from "@myoxus/icons/lit";
import { css, LitElement } from "lit";

export class HighlightDuotoneIcon extends LitElement {
  static override styles = css`
    svg {
      display: flex;
      font-size: 20px;
    }
    svg > path:nth-child(1) {
      fill: var(--background, unset);
    }
    svg > path:nth-child(2) {
      fill: var(--color, #77757d);
    }
  `;
  override render() {
    return HighLightDuotoneIcon();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-highlight-duotone-icon": HighlightDuotoneIcon;
  }
}
