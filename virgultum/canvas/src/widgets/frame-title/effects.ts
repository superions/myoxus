import { EdgelessFrameTitleEditor } from "./native-frame-title-editor.js";
import { MYOXUS_FRAME_TITLE } from "./frame-title.js";
import { MyoxusFrameTitle } from "./native-frame-title.js";
export function effects() {
  customElements.define(MYOXUS_FRAME_TITLE, MyoxusFrameTitle);
  customElements.define(
    "edgeless-frame-title-editor",
    EdgelessFrameTitleEditor,
  );
}
