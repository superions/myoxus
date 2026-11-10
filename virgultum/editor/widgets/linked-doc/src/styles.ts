import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

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
