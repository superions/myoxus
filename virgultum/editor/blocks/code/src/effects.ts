import { CodeBlockComponent } from "./code-block";
import {
  MYOXUS_CODE_TOOLBAR_WIDGET,
  MyoxusCodeToolbarWidget,
} from "./code-toolbar";
import { MyoxusCodeUnit } from "./highlight/myoxus-code-unit";

export function effects() {
  customElements.define(MYOXUS_CODE_TOOLBAR_WIDGET, MyoxusCodeToolbarWidget);
  customElements.define("myoxus-code-unit", MyoxusCodeUnit);
  customElements.define("myoxus-code", CodeBlockComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_CODE_TOOLBAR_WIDGET]: MyoxusCodeToolbarWidget;
  }
}
