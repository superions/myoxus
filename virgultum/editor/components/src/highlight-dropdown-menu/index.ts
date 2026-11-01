import { HighlightDropdownMenu } from "./dropdown-menu";
import { HighlightDuotoneIcon } from "./highlight-duotone-icon";
import { TextDuotoneIcon } from "./text-duotone-icon";

export * from "./dropdown-menu";
export * from "./highlight-duotone-icon";
export * from "./text-duotone-icon";

export function effects() {
  customElements.define(
    "myoxus-highlight-dropdown-menu",
    HighlightDropdownMenu,
  );
  customElements.define("myoxus-highlight-duotone-icon", HighlightDuotoneIcon);
  customElements.define("myoxus-text-duotone-icon", TextDuotoneIcon);
}
