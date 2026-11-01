import { css } from "lit";

export const styles = css`
  .myoxus-block-component.border.light .selected-style {
    border-radius: 8px;
    box-shadow: 0px 0px 0px 1px var(--myoxus-brand-color);
  }
  .myoxus-block-component.border.dark .selected-style {
    border-radius: 8px;
    box-shadow: 0px 0px 0px 1px var(--myoxus-brand-color);
  }
  @media print {
    .myoxus-block-component.border.light .selected-style,
    .myoxus-block-component.border.dark .selected-style {
      box-shadow: none;
    }
  }
`;
