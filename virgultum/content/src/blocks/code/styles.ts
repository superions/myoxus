import { scrollbarStyle } from "@virgultum/core/styles";
import { cssVar } from "@myoxus/theme";

export const codeBlockStyles = `
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
    padding: 0;
    background: var(--myoxus-background-code-block);
    border: calc(var(--mantine-scale) * 1px) solid var(--myoxus-border-color);
    border-radius: var(--mantine-radius-lg);
    box-sizing: border-box;
  }

  .myoxus-code-block-header {
    display: flex;
    align-items: center;
    height: 36px;
    min-height: 36px;
    padding: 0 12px 0 16px;
    background: var(--myoxus-background-secondary-color);
    border-bottom: calc(var(--mantine-scale, 1) * 1px) solid var(--myoxus-border-color);
    border-start-start-radius: calc(var(--mantine-radius-lg, 8px) - 1px);
    border-start-end-radius: calc(var(--mantine-radius-lg, 8px) - 1px);
    font-family: var(--mantine-font-family, var(--myoxus-font-family));
    font-size: var(--mantine-font-size-xs, 12px);
    font-weight: 500;
    line-height: 1;
    color: var(--myoxus-text-secondary-color);
    user-select: none;
    pointer-events: none;
    box-sizing: border-box;
  }

  .myoxus-code-block-header::before {
    content: attr(data-language);
  }

  .myoxus-code-block-body {
    padding: 12px 16px;
  }

  .myoxus-code-block-container.mobile .myoxus-code-block-body {
    padding: 12px;
  }

  .myoxus-code-block-container.highlight-comment {
    outline: 2px solid ${cssVar("primaryColor")};
  }

  ${scrollbarStyle(".myoxus-code-block-container rich-text")}

  /* In Chromium 121+, non-auto scrollbar-width/color override ::-webkit-scrollbar styles. */
  @supports not selector(::-webkit-scrollbar) {
    .myoxus-code-block-container rich-text {
      scrollbar-width: thin;
      scrollbar-color: ${cssVar("iconSecondary")} transparent;
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
    text-align: end;
    font-variant-numeric: tabular-nums;
    padding-right: 12px;
    width: 36px;
    word-break: break-word;
    white-space: nowrap;
    left: -0.5px;
    z-index: 1;
    background: var(--myoxus-background-code-block);
    color: var(--myoxus-text-secondary-color, var(--myoxus-text-secondary));
    opacity: 0.65;
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
