import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

/**
 * ArtifactSkeleton
 *
 * A lightweight loading skeleton used while an artifact preview is fetching / processing.
 * It mimics the layout of a document – an optional icon followed by several animated grey lines.
 *
 * Animation is implemented with pure CSS keyframes (no framer-motion dependency).
 * Only a single prop is supported for now:
 *   - `icon` – TemplateResult that will be rendered at the top-left position.
 */
export class ArtifactSkeleton extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      inline-size: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          6 + ${unsafeCSSValue("var(--mantine-spacing-xs)")}
      );
      block-size: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          5
      );
      box-sizing: border-box;
    }

    .skeleton {
      --myoxus-ai-artifact-skeleton-icon-row: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
      )};

      display: grid;
      grid-template-rows:
        var(--myoxus-ai-artifact-skeleton-icon-row)
        repeat(
          6,
          minmax(
            ${unsafeCSSValue(
              "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
            )},
            auto
          )
        );
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      inline-size: 100%;
      block-size: 100%;
      box-sizing: border-box;
      padding: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
      )}
        ${unsafeCSSValue("var(--mantine-spacing-md)")};
    }

    .skeleton[data-with-icon="false"] {
      --myoxus-ai-artifact-skeleton-icon-row: ${unsafeCSSValue("0")};
    }

    .icon {
      inline-size: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
      )};
      block-size: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
      )};

      svg {
        color: ${unsafeCSSVar("primaryColor")};
        inline-size: 100%;
        block-size: 100%;
      }
    }

    .line {
      block-size: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
      )};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-md)")};
      background-color: ${unsafeCSSVar("backgroundTertiaryColor")};
      animation: skeleton-line-pulse 3.2s ease-in-out infinite;
    }

    @keyframes skeleton-line-pulse {
      50% {
        opacity: 0.54;
      }
    }

    .line1 {
      inline-size: 48%;
    }
    .line2 {
      inline-size: 92%;
      animation-duration: 4.1s;
    }
    .line3 {
      inline-size: 76%;
      animation-duration: 2.8s;
    }
    .line4 {
      inline-size: 56%;
      animation-duration: 3.7s;
    }
    .line5 {
      inline-size: 66%;
      animation-duration: 3.5s;
    }
    .line6 {
      inline-size: 72%;
      animation-duration: 4.3s;
    }
  `;

  /**
   * Optional icon rendered at the top-left corner.
   * It should be a lit `TemplateResult`, typically an inline SVG.
   */
  @property({ attribute: false })
  accessor icon: TemplateResult | null = null;

  override render() {
    return html`<div class="skeleton" data-with-icon=${Boolean(this.icon)}>
      ${this.icon ? html`<div class="icon">${this.icon}</div>` : nothing}
      <div class="line line1"></div>
      <div class="line line2"></div>
      <div class="line line3"></div>
      <div class="line line4"></div>
      <div class="line line5"></div>
      <div class="line line6"></div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "artifact-skeleton": ArtifactSkeleton;
  }
}
