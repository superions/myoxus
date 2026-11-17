import {
  MYOXUS_KEYBOARD_TOOLBAR_WIDGET,
  MyoxusKeyboardToolbarWidget,
} from "./index.js";
import {
  MYOXUS_KEYBOARD_TOOL_PANEL,
  MyoxusKeyboardToolPanel,
} from "./keyboard-tool-panel.js";
import {
  MYOXUS_KEYBOARD_TOOLBAR,
  MyoxusKeyboardToolbar,
} from "./keyboard-toolbar.js";

export function effects() {
  customElements.define(
    MYOXUS_KEYBOARD_TOOLBAR_WIDGET,
    MyoxusKeyboardToolbarWidget,
  );
  customElements.define(MYOXUS_KEYBOARD_TOOLBAR, MyoxusKeyboardToolbar);
  customElements.define(MYOXUS_KEYBOARD_TOOL_PANEL, MyoxusKeyboardToolPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_KEYBOARD_TOOLBAR]: MyoxusKeyboardToolbar;
    [MYOXUS_KEYBOARD_TOOL_PANEL]: MyoxusKeyboardToolPanel;
  }
}
