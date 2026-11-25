import { CalloutBlockComponent } from "./callout-block";

export function effects() {
  customElements.define("myoxus-callout", CalloutBlockComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-callout": CalloutBlockComponent;
  }
}
