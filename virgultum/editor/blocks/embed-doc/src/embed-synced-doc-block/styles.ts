import { embedNoteContentStyles } from "@virgultum/block-embed";
import { EMBED_CARD_HEIGHT } from "@virgultum/shared/consts";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css, html } from "lit";

export const blockStyles = css`
  myoxus-embed-synced-doc-block {
    --embed-padding: 24px;
  }
  myoxus-embed-synced-doc-block[data-page-mode] {
    width: calc(100% + var(--embed-padding) * 2);
    margin-left: calc(-1 * var(--embed-padding));
    margin-right: calc(-1 * var(--embed-padding));
  }
  .edgeless-block-portal-embed
    > myoxus-embed-synced-doc-block[data-nested-editor] {
    position: relative;
    display: block;
    left: 0px;
    top: 0px;
    width: 100%;
    height: 100%;
  }

  .edgeless-block-portal-embed
    .myoxus-embed-synced-doc-editor
    .myoxus-page-root-block-container {
    width: 100%;
  }

  .edgeless-block-portal-embed .myoxus-embed-synced-doc-container.edgeless {
    display: block;
    padding: 0;
    width: 100%;
    height: calc(${EMBED_CARD_HEIGHT.syncedDoc}px + 36px);
  }
  .edgeless-block-portal-embed .myoxus-embed-synced-doc-container.surface {
    border: 1px solid var(--myoxus-border-color);
  }

  myoxus-embed-synced-doc-block[data-nested-editor],
  myoxus-embed-edgeless-synced-doc-block[data-nested-editor] {
    .myoxus-embed-synced-doc-container.page {
      padding: 0 var(--embed-padding);
    }
  }

  .myoxus-embed-synced-doc-editor {
    pointer-events: none;
  }

  .myoxus-embed-synced-doc-container {
    border: 1px solid transparent;
    border-radius: 8px;
    overflow: hidden;
  }
  .myoxus-embed-synced-doc-container.comment-highlighted {
    outline: 2px solid ${unsafeCSSVar("primaryColor")};
  }
  .myoxus-embed-synced-doc-container.show-hover-border:hover {
    border-color: var(--myoxus-border-color);
  }
  .myoxus-embed-synced-doc-container.page {
    display: block;
    width: 100%;
  }
  .myoxus-embed-synced-doc-container.edgeless {
    display: block;
    width: 100%;
    height: calc(${EMBED_CARD_HEIGHT.syncedDoc}px + 36px);
  }
  .myoxus-embed-synced-doc-header-wrapper {
    position: absolute;
    top: 0;
    left: 0;
    height: 34px;
    width: 100%;
    background-color: var(--myoxus-white);
    opacity: 0;
  }
  @media print {
    .myoxus-embed-synced-doc-header-wrapper {
      display: none;
    }
  }
  .myoxus-embed-synced-doc-header-wrapper.selected {
    opacity: 1;
    transition: all 0.23s ease;
  }
  .myoxus-embed-synced-doc-header {
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    padding: 0 var(--embed-padding);
    background-color: var(--myoxus-hover-color);
  }
  .myoxus-embed-synced-doc-header svg {
    flex-shrink: 0;
  }
  .myoxus-embed-synced-doc-icon {
    line-height: 0;
    color: ${unsafeCSSVar("iconColor")};
  }
  .myoxus-embed-synced-doc-title {
    font-size: 14px;
    font-weight: 600;
    line-height: 22px;
    margin-left: 8px;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .myoxus-embed-synced-doc-editor-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    cursor: pointer;
  }

  .myoxus-embed-synced-doc-editor-empty {
    display: flex;
    align-items: center;
    width: 100%;
    height: 100%;
    min-height: 44px;
  }

  .myoxus-embed-synced-doc-container.surface
    > .myoxus-embed-synced-doc-editor
    > .myoxus-embed-synced-doc-editor-empty {
    left: 0;
    justify-content: center;
  }

  .myoxus-embed-synced-doc-editor-empty > span {
    color: var(--myoxus-placeholder-color);
    font-feature-settings:
      "clig" off,
      "liga" off;
    font-family: var(--myoxus-font-family);
    font-size: 15px;
    font-style: normal;
    font-weight: 400;
    line-height: 24px;
  }

  .myoxus-embed-synced-doc-container.surface {
    border-color: ${unsafeCSSVar("borderColor")};
    background: ${unsafeCSSVar("backgroundPrimaryColor")};

    myoxus-preview-root {
      padding: 0 24px;
    }
  }

  .myoxus-embed-synced-doc-container
    > .myoxus-embed-synced-doc-editor.myoxus-page-viewport {
    background: transparent;
  }

  .myoxus-embed-synced-doc-container > .myoxus-embed-synced-doc-editor {
    width: 100%;
    height: 100%;
  }

  .myoxus-embed-synced-doc-editor .myoxus-page-root-block-container {
    width: 100%;
    max-width: 100%;
  }

  @container (max-width: 640px) {
    myoxus-embed-synced-doc-block {
      --embed-padding: 8px;
    }
    .myoxus-embed-synced-doc-title {
      font-weight: 400;
    }
    .myoxus-embed-synced-doc-header-wrapper {
      height: 33px;
    }
  }
`;

// Nested preview clipping and image geometry remain renderer-owned.
export const cardStyles = css`
  .myoxus-embed-synced-doc-card {
    height: 100%;
    user-select: none;
  }
  .myoxus-embed-synced-doc-content-note.render {
    overflow: hidden;
    pointer-events: none;
    max-height: 40px;
  }
  .myoxus-embed-synced-doc-card.surface
    .myoxus-embed-synced-doc-content-note.render {
    max-height: 320px;
  }
  .myoxus-embed-synced-doc-card-banner.render {
    pointer-events: none;
    overflow: hidden;
  }
  .myoxus-embed-synced-doc-card-banner.render img {
    max-width: 100%;
    height: 102px;
    object-fit: cover;
  }
  ${embedNoteContentStyles}
`;

export const LightSyncedDocErrorBanner = html`<svg
  width="340"
  height="171"
  viewBox="0 0 340 171"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
>
  <g clip-path="url(#clip0_6122_32955)">
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M159.19 14.3317L178.489 53.8348L142.603 95.6828L150.082 105.622L128.309 102.546C125.587 102.162 123.07 104.067 122.687 106.802C122.304 109.537 124.201 112.065 126.923 112.45L158.585 116.922L167.84 129.222L164.27 136.241L124.382 130.606C121.66 130.222 119.143 132.127 118.76 134.862C118.377 137.597 120.274 140.125 122.996 140.51L159.476 145.663L146.19 171.778L155.104 215.74L78.791 204.961C73.3466 204.192 69.5537 199.134 70.3192 193.665L95.2679 15.4017C96.0334 9.93217 101.067 6.12164 106.512 6.89067L159.19 14.3317ZM191.977 66.6249L160.492 98.2097L165.699 107.828L210.458 114.15C213.18 114.535 215.076 117.063 214.694 119.798C214.311 122.533 211.794 124.438 209.072 124.054L171.619 118.763L178.062 130.666L174.281 137.655L206.531 142.21C209.253 142.595 211.149 145.123 210.767 147.858C210.384 150.593 207.867 152.498 205.145 152.114L169.205 147.037L155.135 173.041L157.943 216.141L233.231 226.776C238.675 227.545 243.709 223.734 244.475 218.265L259.721 109.326C260.231 105.68 257.703 102.308 254.073 101.796L208.07 95.2975C197.181 93.7594 189.595 83.6447 191.126 72.7056L191.977 66.6249ZM206.99 31.1828C207.502 27.5282 212.156 26.3192 214.367 29.2668L256.041 84.8329C258.251 87.7805 255.811 91.9418 252.173 91.4279L209.456 85.394C204.012 84.6249 200.219 79.5676 200.984 74.098L206.99 31.1828Z"
      fill="#E6E6E6"
    />
  </g>
  <defs>
    <clipPath id="clip0_6122_32955">
      <rect
        width="340"
        height="170"
        fill="white"
        transform="translate(0 0.5)"
      />
    </clipPath>
  </defs>
</svg>`;

export const DarkSyncedDocErrorBanner = html`<svg
  width="340"
  height="171"
  viewBox="0 0 340 171"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
>
  <g clip-path="url(#clip0_6122_32972)">
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M159.191 14.3317L178.489 53.8348L142.603 95.6828L150.082 105.622L128.309 102.546C125.587 102.162 123.07 104.067 122.687 106.802C122.304 109.537 124.201 112.065 126.923 112.45L158.585 116.922L167.841 129.222L164.27 136.241L124.382 130.606C121.66 130.222 119.143 132.127 118.76 134.862C118.377 137.597 120.274 140.125 122.996 140.51L159.477 145.663L146.19 171.778L155.105 215.74L78.7912 204.961C73.3469 204.192 69.5539 199.134 70.3194 193.665L95.2681 15.4017C96.0336 9.93217 101.068 6.12164 106.512 6.89067L159.191 14.3317ZM191.978 66.6249L160.492 98.2097L165.699 107.828L210.458 114.15C213.18 114.535 215.077 117.063 214.694 119.798C214.311 122.533 211.794 124.438 209.072 124.054L171.619 118.763L178.063 130.666L174.281 137.655L206.531 142.21C209.253 142.595 211.15 145.123 210.767 147.858C210.384 150.593 207.867 152.498 205.145 152.114L169.205 147.037L155.135 173.041L157.943 216.141L233.231 226.776C238.675 227.545 243.709 223.734 244.475 218.265L259.721 109.326C260.232 105.68 257.703 102.308 254.074 101.796L208.07 95.2975C197.181 93.7594 189.596 83.6447 191.127 72.7056L191.978 66.6249ZM206.991 31.1828C207.502 27.5282 212.156 26.3192 214.367 29.2668L256.041 84.8329C258.252 87.7805 255.811 91.9418 252.174 91.4279L209.456 85.394C204.012 84.6249 200.219 79.5676 200.984 74.098L206.991 31.1828Z"
      fill="#313131"
    />
  </g>
  <defs>
    <clipPath id="clip0_6122_32972">
      <rect
        width="340"
        height="170"
        fill="white"
        transform="translate(0 0.5)"
      />
    </clipPath>
  </defs>
</svg>`;
