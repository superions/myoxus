import { embedNoteContentStyles } from "../../embed/index";
import { EMBED_CARD_HEIGHT } from "@virgultum/core/consts";
import { unsafeCSSVar } from "@virgultum/core/theme";
import { css } from "lit";

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
  /* Selected previews start at the target body rather than a document title.
     Keep the existing source header in flow so it cannot cover that body. */
  .myoxus-embed-synced-doc-container.page.selected-reference {
    display: flex;
    flex-direction: column;
  }
  .page.selected-reference > .myoxus-embed-synced-doc-header-wrapper {
    position: static;
    order: -1;
    opacity: 1;
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
