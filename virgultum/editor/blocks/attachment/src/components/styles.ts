import { fontXSStyle, panelBaseStyle } from "@virgultum/shared/styles";
import { css } from "lit";

export const renameStyles = css`
  ${panelBaseStyle(".myoxus-attachment-rename-container")}
  .myoxus-attachment-rename-container {
    position: relative;
    display: flex;
    align-items: center;
    width: 320px;
    gap: 12px;
    padding: 12px;
    z-index: var(--myoxus-z-index-popover);
  }

  .myoxus-attachment-rename-input-wrapper {
    display: flex;
    min-width: 280px;
    height: 30px;
    box-sizing: border-box;
    padding: 4px 10px;
    background: var(--myoxus-white-10);
    border-radius: 4px;
    border: 1px solid var(--myoxus-border-color);
  }

  .myoxus-attachment-rename-input-wrapper:focus-within {
    border-color: var(--myoxus-blue-700);
    box-shadow: var(--myoxus-active-shadow);
  }

  .myoxus-attachment-rename-input-wrapper input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    color: var(--myoxus-text-primary-color);
  }
  ${fontXSStyle(".myoxus-attachment-rename-input-wrapper input")}

  .myoxus-attachment-rename-input-wrapper input::placeholder {
    color: var(--myoxus-placeholder-color);
  }

  .myoxus-attachment-rename-extension {
    font-size: var(--myoxus-font-xs);
    color: var(--myoxus-text-secondary-color);
  }

  .myoxus-attachment-rename-overlay-mask {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: var(--myoxus-z-index-popover);
  }
`;

export const styles = css`
  :host {
    z-index: 1;
  }
`;
