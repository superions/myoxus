import { scrollbarStyle } from "@virgultum/shared/styles";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

export const codeBlockStyles = css`
  myoxus-code {
    display: block;
  }

  .myoxus-code-block-container {
    font-family: var(
      --myoxus-typography-code-block-family,
      var(--myoxus-font-code-family)
    );
    font-size: calc(
      var(--myoxus-typography-code-block-size, var(--myoxus-font-xs)) *
        var(--myoxus-document-reading-scale, 1)
    );
    font-style: var(--myoxus-typography-code-block-font-style, normal);
    font-weight: var(--myoxus-typography-code-block-weight, 400);
    letter-spacing: var(--myoxus-typography-code-block-letter-spacing, normal);
    line-height: var(
      --myoxus-typography-code-block-line-height,
      var(--myoxus-line-height)
    );
    text-decoration: var(--myoxus-typography-code-block-decoration, none);
    text-transform: var(--myoxus-typography-code-block-text-transform, none);
    position: relative;
    padding: 32px 20px;
    background: var(--myoxus-background-code-block);
    border: calc(var(--mantine-scale) * 1px) solid var(--myoxus-border-color);
    border-radius: var(--mantine-radius-xl);
    box-sizing: border-box;
  }

  .myoxus-code-block-container.mobile {
    padding: 12px;
  }

  .myoxus-code-block-container.highlight-comment {
    outline: 2px solid ${unsafeCSSVar("primaryColor")};
  }

  ${scrollbarStyle(".myoxus-code-block-container rich-text")}

  /* In Chromium 121+, non-auto scrollbar-width/color override ::-webkit-scrollbar styles. */
  @supports not selector(::-webkit-scrollbar) {
    .myoxus-code-block-container rich-text {
      scrollbar-width: thin;
      scrollbar-color: ${unsafeCSSVar("iconSecondary")} transparent;
      scrollbar-gutter: stable both-edges;
    }
  }

  .myoxus-code-block-container .inline-editor {
    font-variant-ligatures: none;
  }

  .myoxus-code-block-container v-line {
    position: relative;
    display: inline-grid !important;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .myoxus-code-block-container.disable-line-numbers v-line {
    grid-template-columns: unset;
  }

  .myoxus-code-block-container div:has(> v-line) {
    display: grid;
  }

  .myoxus-code-block-container .line-number {
    position: sticky;
    text-align: left;
    padding-right: 12px;
    width: 32px;
    word-break: break-word;
    white-space: nowrap;
    left: -0.5px;
    z-index: 1;
    background: var(--myoxus-background-code-block);
    color: var(--myoxus-text-secondary);
    box-sizing: border-box;
    user-select: none;
  }

  .myoxus-code-block-container.disable-line-numbers .line-number {
    display: none;
  }

  myoxus-code .myoxus-code-block-preview {
    padding: 12px;
  }
`;
