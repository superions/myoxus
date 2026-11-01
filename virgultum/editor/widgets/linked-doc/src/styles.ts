import { baseTheme } from "@myoxus/theme";
import { scrollbarStyle } from "@virgultum/shared/styles";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css, unsafeCSS } from "lit";

export const linkedDocWidgetStyles = css`
  .input-mask {
    position: absolute;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 4px;
  }
`;

export const linkedDocPopoverStyles = css`
  :host {
    position: absolute;
  }

  .linked-doc-popover {
    position: fixed;
    left: 0;
    top: 0;
    box-sizing: border-box;
    font-family: ${unsafeCSS(baseTheme.fontSansFamily)};
    font-size: var(--myoxus-font-base);
    padding: 8px;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    gap: 4px;

    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    box-shadow: ${unsafeCSSVar("overlayPanelShadow")};
    border-radius: 4px;
    z-index: var(--myoxus-z-index-popover);
  }

  .linked-doc-popover icon-button {
    justify-content: flex-start;
    gap: 12px;
    padding: 0 8px;
  }

  .linked-doc-popover .group-title {
    color: var(--myoxus-text-secondary-color);
    padding: 0 8px;
    height: 30px;
    font-size: var(--myoxus-font-xs);
    display: flex;
    align-items: center;
    flex-shrink: 0;
    font-weight: 500;
    justify-content: space-between;
    max-width: 240px;
  }

  .linked-doc-popover .group-title .group-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .linked-doc-popover .group-title .loading-icon {
    display: flex;
    align-items: center;
    margin-left: 8px;
  }

  .linked-doc-popover .group-title .loading-icon svg {
    width: 20px;
    height: 20px;
  }

  .linked-doc-popover .divider {
    border-top: 0.5px solid ${unsafeCSSVar("borderColor")};
  }

  .group icon-button svg,
  .group icon-button .icon {
    width: 20px;
    height: 20px;
  }
  .group icon-button .icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .linked-doc-popover .group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  ${scrollbarStyle(".linked-doc-popover")}
`;

export const mobileLinkedDocMenuStyles = css`
  :host {
    height: 220px;
    width: 100%;
    position: fixed;
    overflow-y: auto;

    display: flex;
    flex-direction: column;
    align-items: flex-start;
    flex-shrink: 0;

    --border-style: 1px solid ${unsafeCSSVar("borderColor")};

    border-radius: 12px 12px 0px 0px;
    border-top: var(--border-style);
    border-right: var(--border-style);
    border-left: var(--border-style);
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    box-shadow: 0px -3px 10px 0px rgba(0, 0, 0, 0.07);
  }

  :host::-webkit-scrollbar {
    display: none;
  }

  .divider {
    width: 100%;
    border-top: 0.5px solid ${unsafeCSSVar("borderColor")};
  }

  .mobile-linked-doc-menu-item {
    display: flex;
    width: 100%;
    height: 44px;
    flex-shrink: 0;
    padding: 11px 20px;
    justify-content: flex-start;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    box-sizing: border-box;

    border: none;
    background: inherit;

    > svg {
      width: 20px;
      height: 20px;
      color: ${unsafeCSSVar("iconColor")};
    }

    .text {
      overflow: hidden;
      color: ${unsafeCSSVar("textPrimaryColor")};
      text-align: justify;
      text-overflow: ellipsis;

      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 17px;
      font-style: normal;
      font-weight: 400;
      line-height: 22px;
      letter-spacing: -0.43px;
    }
  }

  .mobile-linked-doc-menu-item:active {
    background: ${unsafeCSSVar("hoverColor")};
  }
`;
