import { EdgelessFrameTitleEditor } from "./edgeless-frame-title-editor.js";
import { MYOXUS_FRAME_TITLE, MyoxusFrameTitle } from "./frame-title.js";
import {
  MYOXUS_FRAME_TITLE_WIDGET,
  MyoxusFrameTitleWidget,
} from "./myoxus-frame-title-widget.js";

export function effects() {
  customElements.define(MYOXUS_FRAME_TITLE_WIDGET, MyoxusFrameTitleWidget);
  customElements.define(MYOXUS_FRAME_TITLE, MyoxusFrameTitle);
  customElements.define(
    "edgeless-frame-title-editor",
    EdgelessFrameTitleEditor,
  );
}
