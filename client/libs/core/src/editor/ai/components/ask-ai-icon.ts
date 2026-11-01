import { AIStarIcon } from "@virgultum/editor/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle, fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

export type ButtonSize = "small" | "middle" | "large";

const buttonWidthMap: Record<ButtonSize, string> = {
  small: `calc(calc(var(--mantine-spacing-2xl) * 2) + var(--mantine-spacing-sm))`,
  middle: `calc(calc(var(--mantine-spacing-2xl) * 2) + var(--mantine-spacing-md))`,
  large: `calc(calc(var(--mantine-spacing-2xl) * 2) + calc(var(--mantine-spacing-lg) + var(--mantine-spacing-2xs)))`,
};

const buttonHeightMap: Record<ButtonSize, string> = {
  small: "var(--mantine-spacing-xl)",
  middle: "var(--mantine-spacing-2xl)",
  large: "var(--mantine-spacing-2xl)",
};

export class AskAIIcon extends WithDisposable(LitElement) {
  @property({ attribute: false })
  accessor size!: ButtonSize;

  static override styles = css`
    .ask-ai-icon-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      color: ${unsafeCSSVar("textEmphasisColor")};
    }

    .ask-ai-icon-button svg {
      width: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      height: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      color: ${unsafeCSSVar("textEmphasisColor")};
    }

    .ask-ai-icon-button.small svg {
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
      )};
    }

    .ask-ai-icon-button.large svg {
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
    }

    ${fontSMStyle(".ask-ai-icon-button")}
    ${fontXSStyle(".ask-ai-icon-button.small")}
  `;

  override render() {
    return html`
      <icon-button
        class="ask-ai-icon-button ${this.size}"
        width=${buttonWidthMap[this.size]}
        height=${buttonHeightMap[this.size]}
      >
        ${AIStarIcon}
        <span>Ask AI</span>
      </icon-button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ask-ai-icon": AskAIIcon;
  }
}
