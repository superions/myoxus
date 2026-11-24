import { cssVar } from "@myoxus/theme";

export const latexBlockStyles = `
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
    background: ${cssVar("hoverColor")};
  }

  .latex-block-error-placeholder {
    color: ${cssVar("textHighlightForegroundRed")};
    font-family: Inter;
    font-size: 12px;
    font-weight: 500;
    line-height: normal;
    user-select: none;
  }

  .latex-block-empty-placeholder {
    color: ${cssVar("textSecondaryColor")};
    font-family: Inter;
    font-size: 12px;
    font-weight: 500;
    line-height: normal;
    user-select: none;
  }
`;
