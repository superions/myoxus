import { Tooltip } from "./tooltip.js";

export function effects() {
  if (!customElements.get("myoxus-tooltip")) {
    customElements.define("myoxus-tooltip", Tooltip);
  }
}
