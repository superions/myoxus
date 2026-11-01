import type { ResolvedStateInfo } from "@virgultum/components/resource";
import { WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, html } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export const SURFACE_IMAGE_CARD_WIDTH = 220;
export const SURFACE_IMAGE_CARD_HEIGHT = 122;
export const NOTE_IMAGE_CARD_WIDTH = 752;
export const NOTE_IMAGE_CARD_HEIGHT = 78;

export class ImageBlockFallbackCard extends WithDisposable(ShadowlessElement) {
  static override styles = css`
    myoxus-image-fallback-card {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
    }

    .myoxus-image-fallback-card {
      display: flex;
      flex: 1;
      gap: 8px;
      align-self: stretch;
      flex-direction: column;
      justify-content: space-between;
      border-radius: 8px;
      border: 1px solid ${unsafeCSSVar("backgroundTertiaryColor")};
      background: ${unsafeCSSVar("backgroundSecondaryColor")};
      padding: 12px;
    }

    .truncate {
      align-self: stretch;
      text-overflow: ellipsis;
      white-space: nowrap;
      overflow: hidden;
    }

    .myoxus-image-fallback-card-title {
      display: flex;
      flex-direction: row;
      gap: 8px;
      align-items: center;
      align-self: stretch;
    }

    .myoxus-image-fallback-card-title-icon {
      display: flex;
      width: 16px;
      height: 16px;
      align-items: center;
      justify-content: center;
      color: var(--myoxus-text-primary-color);
    }

    .myoxus-image-fallback-card-title-text {
      color: var(--myoxus-placeholder-color);
      font-family: var(--myoxus-font-family);
      font-size: var(--myoxus-font-sm);
      font-style: normal;
      font-weight: 600;
      line-height: 22px;
    }

    .myoxus-image-fallback-card-description {
      color: var(--myoxus-text-secondary-color);
      font-family: var(--myoxus-font-family);
      font-size: var(--myoxus-font-xs);
      font-style: normal;
      font-weight: 400;
      line-height: 20px;
    }

    .myoxus-image-fallback-card.loading {
      .myoxus-image-fallback-card-title {
        color: var(--myoxus-placeholder-color);
      }
    }

    .myoxus-image-fallback-card.error {
      .myoxus-image-fallback-card-title-icon {
        color: ${unsafeCSSVar("errorColor")};
      }
    }
  `;

  override render() {
    const { icon, title, description, loading, error } = this.state;

    const classInfo = {
      "myoxus-image-fallback-card": true,
      "drag-target": true,
      loading,
      error,
    };

    return html`
      <div class=${classMap(classInfo)}>
        <div class="myoxus-image-fallback-card-title">
          <div class="myoxus-image-fallback-card-title-icon">${icon}</div>
          <div class="myoxus-image-fallback-card-title-text truncate">
            ${title}
          </div>
        </div>
        <div class="myoxus-image-fallback-card-description truncate">
          ${description}
        </div>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor state!: ResolvedStateInfo;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-image-fallback-card": ImageBlockFallbackCard;
  }
}
