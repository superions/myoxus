import { CalloutBlockComponent } from "./callout-block";
import { IconPickerWrapper } from "./icon-picker-wrapper";

export function effects() {
  customElements.define("myoxus-callout", CalloutBlockComponent);
  customElements.define("icon-picker-wrapper", IconPickerWrapper);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-callout": CalloutBlockComponent;
    "icon-picker-wrapper": IconPickerWrapper;
  }
}
