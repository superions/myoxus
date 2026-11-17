import { MermaidBlockComponent } from "./mermaid-block.js";
import { MermaidEdgelessBlockComponent } from "./presentation/mermaid-edgeless-block.js";
import {
  MERMAID_PAGE_DRAGGING_AREA_WIDGET,
  MermaidPageDraggingAreaWidget,
} from "./mermaid-page-dragging-area.js";

export function effects() {
  if (!customElements.get("myoxus-mermaid")) {
    customElements.define("myoxus-mermaid", MermaidBlockComponent);
  }
  if (!customElements.get("myoxus-edgeless-mermaid")) {
    customElements.define(
      "myoxus-edgeless-mermaid",
      MermaidEdgelessBlockComponent,
    );
  }
  if (!customElements.get(MERMAID_PAGE_DRAGGING_AREA_WIDGET)) {
    customElements.define(
      MERMAID_PAGE_DRAGGING_AREA_WIDGET,
      MermaidPageDraggingAreaWidget,
    );
  }
}
