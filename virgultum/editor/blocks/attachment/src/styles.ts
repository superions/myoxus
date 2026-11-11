import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

export const styles = css`
  .myoxus-attachment-container {
    box-sizing: border-box;
    user-select: none;
    overflow: hidden;
  }

  .myoxus-attachment-container.comment-highlighted {
    outline: 2px solid ${unsafeCSSVar("primaryColor")};
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
