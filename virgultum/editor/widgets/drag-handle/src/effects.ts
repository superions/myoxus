import {
  EDGELESS_DND_PREVIEW_ELEMENT,
  EdgelessDndPreviewElement,
} from "./components/edgeless-preview/preview";
import { MYOXUS_DRAG_HANDLE_WIDGET } from "./consts";
import { MyoxusDragHandleWidget } from "./drag-handle";

export function effects() {
  customElements.define(MYOXUS_DRAG_HANDLE_WIDGET, MyoxusDragHandleWidget);
  customElements.define(
    EDGELESS_DND_PREVIEW_ELEMENT,
    EdgelessDndPreviewElement,
  );
}
