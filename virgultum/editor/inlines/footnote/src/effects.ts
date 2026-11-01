import { MyoxusFootnoteNode } from "./footnote-node/footnote-node";
import { FootNotePopup } from "./footnote-node/footnote-popup";
import { FootNotePopupChip } from "./footnote-node/footnote-popup-chip";

export function effects() {
  customElements.define("myoxus-footnote-node", MyoxusFootnoteNode);
  customElements.define("footnote-popup", FootNotePopup);
  customElements.define("footnote-popup-chip", FootNotePopupChip);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-footnote-node": MyoxusFootnoteNode;
    "footnote-popup": FootNotePopup;
    "footnote-popup-chip": FootNotePopupChip;
  }
}
