import { EdgelessNoteMenu } from "./toolbar/note-menu";
import {
  EdgelessNoteSeniorButton,
  NoteToolbarArtwork,
} from "./toolbar/note-senior-button";

export function effects() {
  customElements.define("edgeless-note-toolbar-artwork", NoteToolbarArtwork);
  customElements.define("edgeless-note-menu", EdgelessNoteMenu);
  customElements.define(
    "edgeless-note-senior-button",
    EdgelessNoteSeniorButton,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-note-toolbar-artwork": NoteToolbarArtwork;
    "edgeless-note-menu": EdgelessNoteMenu;
    "edgeless-note-senior-button": EdgelessNoteSeniorButton;
  }
}
