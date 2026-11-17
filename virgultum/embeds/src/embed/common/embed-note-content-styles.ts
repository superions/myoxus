import { css } from "lit";

export const embedNoteContentStyles = css`
  .myoxus-embed-doc-content-note-blocks myoxus-divider,
  .myoxus-embed-doc-content-note-blocks myoxus-divider > * {
    margin-top: 0px !important;
    margin-bottom: 0px !important;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph,
  .myoxus-embed-doc-content-note-blocks myoxus-list {
    margin-top: 4px !important;
    margin-bottom: 4px !important;
    padding: 0 2px;
  }
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph *,
  .myoxus-embed-doc-content-note-blocks myoxus-list * {
    margin-top: 0px !important;
    margin-bottom: 0px !important;
    padding-top: 0;
    padding-bottom: 0;
    line-height: 20px;
    font-size: var(--myoxus-font-xs);
    font-weight: 400;
  }
  .myoxus-embed-doc-content-note-blocks myoxus-list .myoxus-list-block__prefix {
    height: 20px;
  }
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph .quote {
    padding-left: 15px;
    padding-top: 8px;
    padding-bottom: 8px;
  }
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h1),
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h2),
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h3),
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h4),
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h5),
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h6) {
    margin-top: 6px !important;
    margin-bottom: 4px !important;
    padding: 0 2px;
  }
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h1) *,
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h2) *,
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h3) *,
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h4) *,
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h5) *,
  .myoxus-embed-doc-content-note-blocks myoxus-paragraph:has(.h6) * {
    margin-top: 0px !important;
    margin-bottom: 0px !important;
    padding-top: 0;
    padding-bottom: 0;
    line-height: 20px;
    font-size: var(--myoxus-font-xs);
    font-weight: 600;
  }

  .myoxus-embed-doc-content-note-blocks inline-comment {
    background-color: unset !important;
    border-bottom: unset !important;
  }

  .myoxus-embed-linked-doc-block.horizontal {
    myoxus-paragraph,
    myoxus-list {
      margin-top: 0 !important;
      margin-bottom: 0 !important;
      max-height: 40px;
      overflow: hidden;
      display: flex;
    }
    myoxus-paragraph .quote {
      padding-top: 4px;
      padding-bottom: 4px;
      height: 28px;
    }
    myoxus-paragraph .quote::after {
      height: 20px;
      margin-top: 4px !important;
      margin-bottom: 4px !important;
    }
  }
`;
