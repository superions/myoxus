import { MYOXUS_SLASH_MENU_WIDGET } from "./consts";
import { MyoxusSlashMenuWidget } from "./widget";

export function effects() {
  customElements.define(MYOXUS_SLASH_MENU_WIDGET, MyoxusSlashMenuWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_SLASH_MENU_WIDGET]: MyoxusSlashMenuWidget;
  }
}
