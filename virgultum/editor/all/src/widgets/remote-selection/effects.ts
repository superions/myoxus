import { MYOXUS_DOC_REMOTE_SELECTION_WIDGET } from "./doc";
import { MyoxusDocRemoteSelectionWidget } from "./doc/doc-remote-selection";
import {
  EdgelessRemoteSelectionWidget,
  MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET,
} from "./edgeless";

export function effects() {
  customElements.define(
    MYOXUS_DOC_REMOTE_SELECTION_WIDGET,
    MyoxusDocRemoteSelectionWidget,
  );
  customElements.define(
    MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET,
    EdgelessRemoteSelectionWidget,
  );
}
