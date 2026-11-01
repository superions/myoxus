import { EdgelessNoteBackground } from "./components/edgeless-note-background";
import { EdgelessNoteMask } from "./components/edgeless-note-mask";
import { EdgelessPageBlockTitle } from "./components/edgeless-page-block-title";
import { NoteBlockComponent } from "./note-block";
import {
  EdgelessNoteBlockComponent,
  MYOXUS_EDGELESS_NOTE,
} from "./note-edgeless-block";
export function effects() {
  customElements.define("myoxus-note", NoteBlockComponent);
  customElements.define(MYOXUS_EDGELESS_NOTE, EdgelessNoteBlockComponent);
  customElements.define("edgeless-note-mask", EdgelessNoteMask);
  customElements.define("edgeless-note-background", EdgelessNoteBackground);
  customElements.define("edgeless-page-block-title", EdgelessPageBlockTitle);
}
