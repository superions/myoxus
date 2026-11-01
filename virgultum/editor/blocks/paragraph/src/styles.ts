import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

export const paragraphBlockStyles = css`
  myoxus-paragraph {
    box-sizing: border-box;
    display: block;
    font-size: calc(
      var(--myoxus-font-base) * var(--myoxus-document-reading-scale, 1)
    );
  }

  .myoxus-paragraph-block-container {
    position: relative;
    border-radius: 4px;
  }
  .myoxus-paragraph-rich-text-wrapper {
    position: relative;
  }

  .myoxus-paragraph-block-container.highlight-comment {
    background-color: ${unsafeCSSVar("backgroundProcessingColor")};
    outline: 2px solid ${unsafeCSSVar("primaryColor")};
  }

  myoxus-paragraph code {
    padding: 0px 4px 2px;
  }

  .h1 {
    font-size: calc(
      var(--myoxus-font-h-1) * var(--myoxus-document-reading-scale, 1)
    );
    font-family: var(--myoxus-typography-h1-family);
    font-weight: var(--myoxus-typography-h1-weight);
    font-style: var(--myoxus-typography-h1-font-style);
    letter-spacing: var(--myoxus-typography-h1-letter-spacing);
    line-height: var(--myoxus-typography-h1-line-height);
    text-transform: var(--myoxus-typography-h1-text-transform, none);
    text-decoration: var(--myoxus-typography-h1-decoration, none);
    margin-top: 18px;
    margin-bottom: 10px;
  }

  .h1 code {
    padding: 0px 4px;
  }

  .h2 {
    font-size: calc(
      var(--myoxus-font-h-2) * var(--myoxus-document-reading-scale, 1)
    );
    font-family: var(--myoxus-typography-h2-family);
    font-weight: var(--myoxus-typography-h2-weight);
    font-style: var(--myoxus-typography-h2-font-style);
    letter-spacing: var(--myoxus-typography-h2-letter-spacing);
    line-height: var(--myoxus-typography-h2-line-height);
    text-transform: var(--myoxus-typography-h2-text-transform, none);
    text-decoration: var(--myoxus-typography-h2-decoration, none);
    margin-top: 14px;
    margin-bottom: 10px;
  }

  .h2 code {
    padding: 0px 4px;
  }

  .h3 {
    font-size: calc(
      var(--myoxus-font-h-3) * var(--myoxus-document-reading-scale, 1)
    );
    font-family: var(--myoxus-typography-h3-family);
    font-weight: var(--myoxus-typography-h3-weight);
    font-style: var(--myoxus-typography-h3-font-style);
    letter-spacing: var(--myoxus-typography-h3-letter-spacing);
    line-height: var(--myoxus-typography-h3-line-height);
    text-transform: var(--myoxus-typography-h3-text-transform, none);
    text-decoration: var(--myoxus-typography-h3-decoration, none);
    margin-top: 12px;
    margin-bottom: 10px;
  }

  .h3 code {
    padding: 0px 4px;
  }

  .h4 {
    font-size: calc(
      var(--myoxus-font-h-4) * var(--myoxus-document-reading-scale, 1)
    );
    font-family: var(--myoxus-typography-h4-family);
    font-weight: var(--myoxus-typography-h4-weight);
    font-style: var(--myoxus-typography-h4-font-style);
    letter-spacing: var(--myoxus-typography-h4-letter-spacing);
    line-height: var(--myoxus-typography-h4-line-height);
    text-transform: var(--myoxus-typography-h4-text-transform, none);
    text-decoration: var(--myoxus-typography-h4-decoration, none);
    margin-top: 12px;
    margin-bottom: 10px;
  }
  .h4 code {
    padding: 0px 4px;
  }

  .h5 {
    font-size: calc(
      var(--myoxus-font-h-5) * var(--myoxus-document-reading-scale, 1)
    );
    font-family: var(--myoxus-typography-h5-family);
    font-weight: var(--myoxus-typography-h5-weight);
    font-style: var(--myoxus-typography-h5-font-style);
    letter-spacing: var(--myoxus-typography-h5-letter-spacing);
    line-height: var(--myoxus-typography-h5-line-height);
    text-transform: var(--myoxus-typography-h5-text-transform, none);
    text-decoration: var(--myoxus-typography-h5-decoration, none);
    margin-top: 12px;
    margin-bottom: 10px;
  }
  .h5 code {
    padding: 0px 4px;
  }

  .h6 {
    font-size: calc(
      var(--myoxus-font-h-6) * var(--myoxus-document-reading-scale, 1)
    );
    font-family: var(--myoxus-typography-h5-family);
    font-weight: var(--myoxus-typography-h5-weight);
    font-style: var(--myoxus-typography-h5-font-style);
    letter-spacing: var(--myoxus-typography-h5-letter-spacing);
    line-height: var(--myoxus-typography-h5-line-height);
    text-transform: var(--myoxus-typography-h5-text-transform, none);
    text-decoration: var(--myoxus-typography-h5-decoration, none);
    margin-top: 12px;
    margin-bottom: 10px;
  }

  .h6 code {
    padding: 0px 4px 2px;
  }

  .myoxus-paragraph-rich-text-wrapper.eyebrow {
    color: var(--myoxus-text-secondary-color);
    font-family: var(--myoxus-typography-label-compact-family);
    font-size: calc(
      var(--myoxus-typography-label-compact-size) *
        var(--myoxus-document-reading-scale, 1)
    );
    font-style: var(--myoxus-typography-label-compact-font-style);
    font-weight: var(--myoxus-typography-label-compact-weight);
    letter-spacing: var(--myoxus-typography-label-compact-letter-spacing);
    line-height: var(--myoxus-typography-label-compact-line-height);
    margin-bottom: var(--myoxus-paragraph-space);
    text-transform: uppercase;
  }

  .quote {
    font-family: var(--myoxus-typography-blockquote-family);
    font-size: calc(
      var(--myoxus-typography-blockquote-size) *
        var(--myoxus-document-reading-scale, 1)
    );
    font-weight: var(--myoxus-typography-blockquote-weight);
    font-style: var(--myoxus-typography-blockquote-font-style);
    letter-spacing: var(--myoxus-typography-blockquote-letter-spacing);
    line-height: var(--myoxus-typography-blockquote-line-height);
    padding-left: 17px;
    margin-top: var(--myoxus-paragraph-space);
    padding-top: 10px;
    padding-bottom: 10px;
    position: relative;
  }
  .quote::after {
    content: "";
    width: 2px;
    height: calc(100% - 20px);
    margin-top: 10px;
    margin-bottom: 10px;
    position: absolute;
    left: 0;
    top: 0;
    background: var(--myoxus-quote-color);
    border-radius: 18px;
  }

  .myoxus-paragraph-placeholder {
    position: absolute;
    display: none;
    max-width: 100%;
    overflow-x: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    left: 0;
    bottom: 0;
    pointer-events: none;
    color: var(--myoxus-placeholder-color);
    fill: var(--myoxus-placeholder-color);
  }
  @media print {
    .myoxus-paragraph-placeholder {
      display: none !important;
    }
  }
  .myoxus-paragraph-placeholder.visible {
    display: block;
  }
  @media print {
    .myoxus-paragraph-placeholder.visible {
      display: none;
    }
  }
`;
