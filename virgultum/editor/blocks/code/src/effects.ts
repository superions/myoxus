import { CodeBlockComponent } from "./code-block";
import {
  MYOXUS_CODE_TOOLBAR_WIDGET,
  MyoxusCodeToolbarWidget,
} from "./code-toolbar";
import { MyoxusCodeToolbar } from "./code-toolbar/components/code-toolbar";
import { LanguageListButton } from "./code-toolbar/components/lang-button";
import { PreviewButton } from "./code-toolbar/components/preview-button";
import { MyoxusCodeUnit } from "./highlight/myoxus-code-unit";

export function effects() {
  customElements.define("language-list-button", LanguageListButton);
  customElements.define("myoxus-code-toolbar", MyoxusCodeToolbar);
  customElements.define(MYOXUS_CODE_TOOLBAR_WIDGET, MyoxusCodeToolbarWidget);
  customElements.define("myoxus-code-unit", MyoxusCodeUnit);
  customElements.define("myoxus-code", CodeBlockComponent);
  customElements.define("preview-button", PreviewButton);
}

declare global {
  interface HTMLElementTagNameMap {
    "language-list-button": LanguageListButton;
    "myoxus-code-toolbar": MyoxusCodeToolbar;
    "preview-button": PreviewButton;
    [MYOXUS_CODE_TOOLBAR_WIDGET]: MyoxusCodeToolbarWidget;
  }
}
