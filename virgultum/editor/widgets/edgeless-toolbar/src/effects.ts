import { EdgelessToolIconButton } from "./button/tool-icon-button";
import { EdgelessToolbarButton } from "./button/toolbar-button";
import {
  EDGELESS_TOOLBAR_WIDGET,
  EdgelessToolbarWidget,
} from "./edgeless-toolbar";
import { EdgelessSlideMenu } from "./menu/slide-menu";
import { ToolbarArrowUpIcon } from "./menu/toolbar-arrow-up-icon";

export function effects() {
  customElements.define(EDGELESS_TOOLBAR_WIDGET, EdgelessToolbarWidget);
  customElements.define("edgeless-toolbar-button", EdgelessToolbarButton);
  customElements.define("edgeless-tool-icon-button", EdgelessToolIconButton);
  customElements.define("edgeless-slide-menu", EdgelessSlideMenu);
  customElements.define("toolbar-arrow-up-icon", ToolbarArrowUpIcon);
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-tool-icon-button": EdgelessToolIconButton;
    "edgeless-toolbar-button": EdgelessToolbarButton;
    "edgeless-toolbar-widget": EdgelessToolbarWidget;
    "edgeless-slide-menu": EdgelessSlideMenu;
    "toolbar-arrow-up-icon": ToolbarArrowUpIcon;
  }
}
