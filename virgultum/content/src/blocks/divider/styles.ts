import { css } from "lit";

export const dividerBlockStyles = css`
  .myoxus-divider-block-container {
    position: relative;
    width: 100%;
    height: 1px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 18px 8px;
    margin-top: var(--myoxus-paragraph-space);
  }
  .myoxus-divider-block-container hr {
    border: none;
    border-top: 1px solid var(--myoxus-divider-color);
    width: 100%;
  }
`;
