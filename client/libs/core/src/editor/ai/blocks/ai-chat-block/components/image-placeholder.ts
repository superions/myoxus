import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

export class ImagePlaceholder extends LitElement {
  static override styles = css`
    .placeholder-container {
      display: flex;
      width: 100%;
      min-height: calc(
        ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} +
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-xl))",
          )} +
          ${unsafeCSSValue("var(--mantine-spacing-2xs)")}
      );
      padding: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      align-items: flex-start;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      background: ${unsafeCSSVar("backgroundSecondaryColor")};
      box-sizing: border-box;
    }

    .placeholder-title {
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      align-items: center;
      color: ${unsafeCSSVar("placeholderColor")};
      text-align: justify;
      min-height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
      )};
    }

    .placeholder-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${unsafeCSSVar("iconColor")};
    }

    ${fontSMStyle(".placeholder-title")}
  `;

  override render() {
    return html`<div class="placeholder-container">
      <div class="placeholder-title">
        <span class="placeholder-icon">${this.icon}</span>
        <span>${this.text}</span>
      </div>
    </div>`;
  }

  @property({ attribute: false })
  accessor icon!: TemplateResult<1>;

  @property({ attribute: false })
  accessor text!: string;
}

declare global {
  interface HTMLElementTagNameMap {
    "image-placeholder": ImagePlaceholder;
  }
}
