import {
  MobileOutlineMenu,
  MYOXUS_MOBILE_OUTLINE_MENU,
} from "./mobile-outline-panel";
import { MYOXUS_OUTLINE_PANEL, OutlinePanel } from "./outline-panel";

export function effects() {
  customElements.define(MYOXUS_OUTLINE_PANEL, OutlinePanel);
  customElements.define(MYOXUS_MOBILE_OUTLINE_MENU, MobileOutlineMenu);
}
