import {
  AIStarIconWithAnimation,
  AIStopIcon,
} from "@virgultum/editor/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle, fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";

import type { AIPanelGeneratingConfig } from "../../type.js";

export class AIPanelGenerating extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      width: 100%;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-md)")};
      box-sizing: border-box;
    }

    .generating-tip {
      display: flex;
      width: 100%;
      min-height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};

      color: var(--myoxus-brand-color);

      .text {
        display: flex;
        align-items: flex-start;
        gap: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
        )};
        flex: 1 0 0;
      }

      .left,
      .right {
        display: flex;
        min-height: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        justify-content: center;
        align-items: center;
      }
      .left {
        width: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
      }
      .right {
        gap: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        )};
      }
      .right:hover {
        cursor: pointer;
      }
      .stop-icon {
        height: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        width: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
      }
    }

    ${fontSMStyle(".text")}
    ${fontXSStyle(".esc-label")}
  `;

  override render() {
    const {
      generatingIcon = AIStarIconWithAnimation,
      stages,
      height,
    } = this.config;
    return html`
      ${
        stages && stages.length > 0
          ? html`<generating-placeholder
              .height=${height}
              .loadingProgress=${this.loadingProgress}
              .stages=${stages}
              .showHeader=${!this.withAnswer}
            ></generating-placeholder>`
          : nothing
      }
      <div class="generating-tip" data-testid="ai-generating">
        <div class="left">${generatingIcon}</div>
        <div class="text">AI is generating...</div>
        <div @click=${this.stopGenerating} class="right" data-testid="ai-stop">
          <span class="stop-icon">${AIStopIcon}</span>
          <span class="esc-label">ESC</span>
        </div>
      </div>
    `;
  }

  updateLoadingProgress(progress: number) {
    this.loadingProgress = progress;
  }

  @property({ attribute: false })
  accessor config!: AIPanelGeneratingConfig;

  @property({ attribute: false })
  accessor loadingProgress: number = 1;

  @property({ attribute: false })
  accessor stopGenerating!: () => void;

  @property({ attribute: false })
  accessor withAnswer!: boolean;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-panel-generating": AIPanelGenerating;
  }
}
