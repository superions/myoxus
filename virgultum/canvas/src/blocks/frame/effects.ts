import { FrameBlockComponent } from "./frame-block";

export function effects() {
  customElements.define("myoxus-frame", FrameBlockComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-frame": FrameBlockComponent;
  }
}
