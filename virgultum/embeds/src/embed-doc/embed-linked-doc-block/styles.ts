import { embedNoteContentStyles } from "../../embed/index";
import { css } from "lit";

// Document-preview clipping belongs to the nested editor renderer, not card chrome.
export const styles = css`
  .myoxus-embed-linked-doc-block {
    height: 100%;
    user-select: none;
  }
  .myoxus-embed-linked-doc-content-note.render {
    overflow: hidden;
    pointer-events: none;
  }
  .myoxus-embed-linked-doc-block:not(.vertical)
    .myoxus-embed-linked-doc-content-note.render {
    max-height: 40px;
  }
  ${embedNoteContentStyles}
`;
