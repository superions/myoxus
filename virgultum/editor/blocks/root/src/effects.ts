import {
  EdgelessRootBlockComponent,
  EdgelessRootPreviewBlockComponent,
  PageRootBlockComponent,
  PreviewRootBlockComponent,
} from "./index.js";

export function effects() {
  // Register components by category
  registerRootComponents();
}

function registerRootComponents() {
  customElements.define("myoxus-page-root", PageRootBlockComponent);
  customElements.define("myoxus-preview-root", PreviewRootBlockComponent);
  customElements.define("myoxus-edgeless-root", EdgelessRootBlockComponent);
  customElements.define(
    "myoxus-edgeless-root-preview",
    EdgelessRootPreviewBlockComponent,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-root": EdgelessRootBlockComponent;
    "myoxus-page-root": PageRootBlockComponent;
  }
}
