import { LoadingIcon } from "@virgultum/editor/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle, fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

export class GeneratingPlaceholder extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .generating-header {
      width: 100%;
    }

    .generating-header,
    .loading-progress {
      color: ${unsafeCSSVar("textSecondaryColor")};
    }

    .generating-body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      width: 100%;
      min-height: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          7 +
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          )}
      );
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      border: ${unsafeCSSValue("var(--mantine-spacing-2xs)")} solid
        ${unsafeCSSVar("primaryColor")};
      background: ${unsafeCSSVar("blue50")};
      color: ${unsafeCSSVar("brandColor")};
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    .generating-icon {
      display: flex;
      justify-content: center;
      align-items: center;
      height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
    }

    .generating-icon svg {
      scale: 1.5;
    }

    .loading-progress {
      display: flex;
      flex-direction: column;
      text-align: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    .loading-text {
      min-height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
    }

    .loading-stage {
      min-height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
    }

    ${fontXSStyle(".generating-header")}
    ${fontSMStyle(".loading-text")}
    ${fontXSStyle(".loading-stage")}
  `;

  protected override render() {
    const loadingText = this.stages[this.loadingProgress - 1] || "";
    const measuredHeight = Number.isFinite(this.height)
      ? this.height
      : undefined;

    return html`${
        measuredHeight === undefined
          ? nothing
          : html`<style>
              .generating-body {
                height: calc(
                  var(--mantine-spacing-2xs) * ${measuredHeight / 2}
                );
              }
            </style>`
      }
      ${
        this.showHeader
          ? html`<div class="generating-header">Answer</div>`
          : nothing
      }
      <div class="generating-body">
        <div class="generating-icon">${LoadingIcon()}</div>
        <div class="loading-progress">
          <div class="loading-text">${loadingText}</div>
          <div class="loading-stage">
            ${this.loadingProgress} / ${this.stages.length}
          </div>
        </div>
      </div>`;
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("loadingProgress")) {
      this.loadingProgress = Math.max(
        1,
        Math.min(this.loadingProgress, this.stages.length),
      );
    }
  }

  @property({ attribute: false })
  accessor height: number | undefined = undefined;

  @property({ attribute: false })
  accessor loadingProgress!: number;

  @property({ attribute: false })
  accessor showHeader!: boolean;

  @property({ attribute: false })
  accessor stages!: string[];
}

declare global {
  interface HTMLElementTagNameMap {
    "generating-placeholder": GeneratingPlaceholder;
  }
}
