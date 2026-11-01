import { css } from "lit";

export const listPrefix = css`
  .myoxus-list-block__prefix {
    display: flex;
    user-select: none;
    position: relative;
  }

  .myoxus-list-block__numbered {
    min-width: 22px;
    height: 24px;
    margin-left: 2px;
  }

  .myoxus-list-block__bulleted {
    display: list-item;
    flex: 0 0 24px;
    height: 24px;
    list-style-position: inside;
  }

  .myoxus-list-block__bulleted[data-list-depth="0"] {
    list-style-type: disc;
  }

  .myoxus-list-block__bulleted[data-list-depth="1"] {
    list-style-type: circle;
  }

  .myoxus-list-block__bulleted[data-list-depth="2"] {
    list-style-type: square;
  }

  .myoxus-list-block__todo-prefix {
    display: flex;
    align-items: center;
    cursor: pointer;
    width: 24px;
    height: 24px;
    color: var(--myoxus-icon-color);
  }

  .myoxus-list-block__todo-prefix.readonly {
    cursor: default;
  }

  .myoxus-list-block__todo-prefix > svg {
    width: 20px;
    height: 20px;
  }
`;

export const listBlockStyles = css`
  myoxus-list {
    display: block;
    font-size: calc(
      var(--myoxus-font-base) * var(--myoxus-document-reading-scale, 1)
    );
  }

  myoxus-list code {
    padding: 0px 4px 2px;
  }

  .myoxus-list-block-container {
    box-sizing: border-box;
    border-radius: 4px;
    position: relative;
  }
  .myoxus-list-block-container .myoxus-list-block-container {
    margin-top: 0;
  }
  .myoxus-list-rich-text-wrapper {
    position: relative;
    display: flex;
  }
  .myoxus-list-rich-text-wrapper rich-text {
    flex: 1;
  }

  .myoxus-list--checked {
    color: var(--myoxus-text-secondary-color);
  }

  .myoxus-list--checked .myoxus-list-block__todo-prefix {
  }

  ${listPrefix}
`;
