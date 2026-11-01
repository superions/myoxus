import { WithDisposable } from "@virgultum/editor/global/lit";
import { scrollbarStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/editor/std";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

export class ChatContentImages extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    .chat-content-images-row {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      margin-block-end: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      max-width: 100%;
      overflow-x: auto;
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      scrollbar-width: auto;
    }

    ${scrollbarStyle(".chat-content-images-row")}

    .chat-content-images-row img {
      max-inline-size: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          4 +
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          )}
      );
      max-block-size: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        )} *
          6 + ${unsafeCSSValue("var(--mantine-spacing-xl)")}
      );
      object-fit: cover;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      flex-shrink: 0;
      image-rendering: pixelated;
    }

    .chat-content-images-column {
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      flex-direction: column;
      margin-block-end: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .chat-content-images-column .image-container {
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      overflow: hidden;
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      inline-size: min(
        100%,
        calc(
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
          )} *
            8
        )
      );
    }

    .chat-content-images-column .image-container img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      image-rendering: pixelated;
    }
  `;

  @property({ attribute: false })
  accessor images: string[] = [];

  @property({ attribute: false })
  accessor layout: "row" | "column" = "row";

  protected override render() {
    if (this.images.length === 0) {
      return nothing;
    }

    if (this.layout === "row") {
      return html`<div class="chat-content-images-row">
        ${repeat(
          this.images,
          (image) => image,
          (image) => html`<img src="${image}" />`,
        )}
      </div>`;
    } else {
      return html`<div class="chat-content-images-column">
        ${repeat(
          this.images,
          (image) => image,
          (image) =>
            html`<div class="image-container">
              <img src="${image}" />
            </div>`,
        )}
      </div>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-content-images": ChatContentImages;
  }
}
