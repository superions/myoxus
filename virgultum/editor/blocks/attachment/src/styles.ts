import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

export const styles = css`
  .myoxus-attachment-container {
    border-radius: 8px;
    box-sizing: border-box;
    user-select: none;
    overflow: hidden;
    border: 1px solid ${unsafeCSSVar("backgroundTertiaryColor")};
    background: ${unsafeCSSVar("backgroundPrimaryColor")};

    &.focused {
      border-color: ${unsafeCSSVar("primaryColor")};
    }
  }

  .myoxus-attachment-container.comment-highlighted {
    outline: 2px solid ${unsafeCSSVar("primaryColor")};
  }

  .myoxus-attachment-card {
    display: flex;
    gap: 12px;
    padding: 12px;
  }

  .myoxus-attachment-content {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    flex: 1 0 0;
    min-width: 0;
  }

  .truncate {
    align-self: stretch;
    text-overflow: ellipsis;
    white-space: nowrap;
    overflow: hidden;
  }

  .myoxus-attachment-content-title {
    display: flex;
    flex-direction: row;
    gap: 8px;
    align-items: center;
    align-self: stretch;
  }

  .myoxus-attachment-content-title-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--myoxus-text-primary-color);
    font-size: 16px;
  }

  .myoxus-attachment-content-title-text {
    color: var(--myoxus-text-primary-color);
    font-family: var(--myoxus-font-family);
    font-size: var(--myoxus-font-sm);
    font-style: normal;
    font-weight: 600;
    line-height: 22px;
  }

  .myoxus-attachment-content-description {
    display: flex;
    align-items: center;
    align-self: stretch;
    gap: 8px;
  }

  .myoxus-attachment-content-info {
    color: var(--myoxus-text-secondary-color);
    font-family: var(--myoxus-font-family);
    font-size: var(--myoxus-font-xs);
    font-style: normal;
    font-weight: 400;
    line-height: 20px;
  }

  .myoxus-attachment-content-button {
    display: flex;
    height: 20px;
    align-items: center;
    align-self: stretch;
    gap: 4px;
    white-space: nowrap;
    padding: 0 4px;
    color: ${unsafeCSSVar("primaryColor")};
    font-family: var(--myoxus-font-family);
    font-size: var(--myoxus-font-xs);
    font-style: normal;
    font-weight: 500;
    text-transform: capitalize;
    line-height: 20px;

    svg {
      font-size: 16px;
    }
  }

  .myoxus-attachment-banner {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .myoxus-attachment-card.loading {
    .myoxus-attachment-content-title-text {
      color: ${unsafeCSSVar("placeholderColor")};
    }
  }

  .myoxus-attachment-card.error {
    .myoxus-attachment-content-title-icon {
      color: ${unsafeCSSVar("errorColor")};
    }
  }

  .myoxus-attachment-card.loading,
  .myoxus-attachment-card.error {
    background: ${unsafeCSSVar("backgroundSecondaryColor")};
  }

  .myoxus-attachment-card.cubeThick {
    flex-direction: column-reverse;

    .myoxus-attachment-content {
      width: 100%;
      flex-direction: column;
      align-items: flex-start;
      justify-content: space-between;
    }

    .myoxus-attachment-banner {
      justify-content: space-between;
    }
  }

  .myoxus-attachment-embed-container {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .myoxus-attachment-embed-status {
    position: absolute;
    left: 14px;
    bottom: 64px;
  }

  .myoxus-attachment-embed-event-mask {
    position: absolute;
    inset: 0;
  }
`;
