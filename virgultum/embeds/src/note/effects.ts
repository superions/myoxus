import { EdgelessNoteMask } from "./components/native-note-mask";
import {
  EdgelessNoteBackground,
  EdgelessPageBlockTitle,
} from "./components/native-note-chrome";
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
