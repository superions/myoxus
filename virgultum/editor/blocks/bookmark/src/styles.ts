import { baseTheme } from "@myoxus/theme";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css, unsafeCSS } from "lit";

export const styles = css`
  bookmark-card {
    display: block;
    height: 100%;
    width: 100%;
  }

  .myoxus-bookmark-card {
    container: myoxus-bookmark-card / inline-size;
    margin: 0 auto;
    box-sizing: border-box;
    display: flex;
    width: 100%;

    border-radius: 8px;
    border: 1px solid ${unsafeCSSVar("backgroundTertiaryColor")};

    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    user-select: none;
  }

  .myoxus-bookmark-content {
    width: calc(100% - 204px);
    display: flex;
    flex-direction: column;
    flex-grow: 1;
    align-self: stretch;
    gap: 4px;
    padding: 12px;
  }

  .myoxus-bookmark-content-title {
    display: flex;
    flex-direction: row;
    gap: 8px;
    align-items: center;

    align-self: stretch;
  }

  .myoxus-bookmark-content-title-icon {
    display: flex;
    width: 16px;
    height: 16px;
    justify-content: center;
    align-items: center;
  }

  .myoxus-bookmark-content-title-icon img,
  .myoxus-bookmark-content-title-icon object,
  .myoxus-bookmark-content-title-icon svg {
    width: 16px;
    height: 16px;
    fill: var(--myoxus-background-primary-color);
  }

  .myoxus-bookmark-content-title-text {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;

    word-break: break-word;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--myoxus-text-primary-color);

    font-family: var(--myoxus-font-family);
    font-size: var(--myoxus-font-sm);
    font-style: normal;
    font-weight: 600;
    line-height: 22px;
  }

  .myoxus-bookmark-content-description {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;

    flex-grow: 1;

    white-space: normal;
    word-break: break-word;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--myoxus-text-primary-color);

    font-family: var(--myoxus-font-family);
    font-size: var(--myoxus-font-xs);
    font-style: normal;
    font-weight: 400;
    line-height: 20px;
  }

  .myoxus-bookmark-content-url {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
    width: max-content;
    max-width: 100%;
  }

  .myoxus-bookmark-content-url > span {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;

    word-break: break-all;
    white-space: normal;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--myoxus-text-secondary-color);

    font-family: ${unsafeCSS(baseTheme.fontSansFamily)};
    font-size: var(--myoxus-font-xs);
    font-style: normal;
    font-weight: 400;
    line-height: 20px;
  }
  .myoxus-bookmark-content-url:hover > span {
    color: var(--myoxus-link-color);
  }
  .myoxus-bookmark-content-url:hover {
    fill: var(--myoxus-link-color);
  }

  .myoxus-bookmark-content-url-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 20px;
  }
  .myoxus-bookmark-content-url-icon {
    height: 12px;
    width: 12px;
    color: ${unsafeCSSVar("iconSecondary")};
  }

  .myoxus-bookmark-banner {
    margin: 12px 12px 0px 0px;
    width: 204px;
    max-width: 100%;
    height: 102px;
  }

  .myoxus-bookmark-banner img,
  .myoxus-bookmark-banner object,
  .myoxus-bookmark-banner svg {
    width: 204px;
    max-width: 100%;
    height: 102px;
    object-fit: cover;
    border-radius: 4px;
  }

  .myoxus-bookmark-card.comment-highlighted {
    outline: 2px solid ${unsafeCSSVar("primaryColor")};
  }

  .myoxus-bookmark-card.loading {
    .myoxus-bookmark-content-title-text {
      color: var(--myoxus-placeholder-color);
    }
  }

  .myoxus-bookmark-card.error {
    .myoxus-bookmark-content-description {
      color: var(--myoxus-placeholder-color);
    }
  }

  .myoxus-bookmark-card.selected {
    .myoxus-bookmark-content-url > span {
      color: var(--myoxus-link-color);
    }
    .myoxus-bookmark-content-url .myoxus-bookmark-content-url-icon {
      color: var(--myoxus-link-color);
    }
  }

  .myoxus-bookmark-card.list {
    .myoxus-bookmark-content {
      width: 100%;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }

    .myoxus-bookmark-content-title {
      width: calc(100% - 204px);
    }

    .myoxus-bookmark-content-url {
      width: 204px;
      justify-content: flex-end;
    }

    .myoxus-bookmark-content-description {
      display: none;
    }

    .myoxus-bookmark-banner {
      display: none;
    }
  }

  .myoxus-bookmark-card.vertical {
    flex-direction: column-reverse;
    height: 100%;

    .myoxus-bookmark-content {
      width: 100%;
    }

    .myoxus-bookmark-content-description {
      -webkit-line-clamp: 6;
      max-height: 120px;
    }

    .myoxus-bookmark-content-url-wrapper {
      max-width: fit-content;
      display: flex;
      align-items: flex-end;
      flex-grow: 1;
      cursor: pointer;
    }

    .myoxus-bookmark-banner {
      width: 340px;
      height: 170px;
      margin-left: 12px;
    }

    .myoxus-bookmark-banner img,
    .myoxus-bookmark-banner object,
    .myoxus-bookmark-banner svg {
      width: 340px;
      height: 170px;
    }
  }

  .myoxus-bookmark-card.cube {
    .myoxus-bookmark-content {
      width: 100%;
      flex-direction: column;
      align-items: flex-start;
      justify-content: space-between;
    }

    .myoxus-bookmark-content-title {
      flex-direction: column;
      gap: 4px;
      align-items: flex-start;
    }

    .myoxus-bookmark-content-title-text {
      -webkit-line-clamp: 2;
    }

    .myoxus-bookmark-content-description {
      display: none;
    }

    .myoxus-bookmark-banner {
      display: none;
    }
  }

  @container myoxus-bookmark-card (width < 375px) {
    .myoxus-bookmark-content {
      width: 100%;
    }
    .myoxus-bookmark-card:not(.edgeless) .myoxus-bookmark-banner {
      display: none;
    }
  }
`;
