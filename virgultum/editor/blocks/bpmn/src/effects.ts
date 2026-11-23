import { BpmnBlockComponent } from "./bpmn-block.js";

export function effects() {
  if (!customElements.get("myoxus-bpmn")) {
    customElements.define("myoxus-bpmn", BpmnBlockComponent);
  }
}
