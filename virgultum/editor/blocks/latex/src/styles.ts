import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

export const latexBlockStyles = css`
  .latex-block-container {
    display: flex;
    position: relative;
    width: 100%;
    height: 100%;
    padding: 10px 24px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    overflow-x: auto;
    user-select: none;
  }

  .latex-block-container:hover {
    background: ${unsafeCSSVar("hoverColor")};
  }

  .latex-block-error-placeholder {
    color: ${unsafeCSSVar("textHighlightForegroundRed")};
    font-family: Inter;
    font-size: 12px;
    font-weight: 500;
    line-height: normal;
    user-select: none;
  }

  .latex-block-empty-placeholder {
    color: ${unsafeCSSVar("textSecondaryColor")};
    font-family: Inter;
    font-size: 12px;
    font-weight: 500;
    line-height: normal;
    user-select: none;
  }
`;
