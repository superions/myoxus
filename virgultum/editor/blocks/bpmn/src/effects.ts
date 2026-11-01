import { BpmnBlockComponent } from "./bpmn-block.js";
import { EdgelessBpmnToolButton } from "./edgeless-toolbar.js";

export function effects() {
  if (!customElements.get("myoxus-bpmn")) {
    customElements.define("myoxus-bpmn", BpmnBlockComponent);
  }
  if (!customElements.get("myoxus-bpmn-edgeless-tool-button")) {
    customElements.define(
      "myoxus-bpmn-edgeless-tool-button",
      EdgelessBpmnToolButton,
    );
  }
}
