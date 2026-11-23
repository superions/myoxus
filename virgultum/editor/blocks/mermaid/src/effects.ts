import { MermaidBlockComponent } from "./mermaid-block.js";
import { MermaidEdgelessBlockComponent } from "./presentation/mermaid-edgeless-block.js";
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
}
