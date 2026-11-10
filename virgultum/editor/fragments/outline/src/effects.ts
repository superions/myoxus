import {
  MobileOutlineMenu,
  MYOXUS_MOBILE_OUTLINE_MENU,
} from "./mobile-outline-panel";
import { MYOXUS_OUTLINE_PANEL, OutlinePanel } from "./outline-panel";
import { MYOXUS_OUTLINE_VIEWER, OutlineViewer } from "./outline-viewer";

export function effects() {
  customElements.define(MYOXUS_OUTLINE_PANEL, OutlinePanel);
  customElements.define(MYOXUS_OUTLINE_VIEWER, OutlineViewer);
  customElements.define(MYOXUS_MOBILE_OUTLINE_MENU, MobileOutlineMenu);
}
