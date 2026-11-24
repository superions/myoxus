import { NativeEditorWidget } from "@virgultum/core/runtime";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import { SelectionToolbarController } from "./selection-controller";

export const MYOXUS_TOOLBAR_WIDGET = "myoxus-toolbar-widget";

export class MyoxusToolbarWidget extends NativeEditorWidget {
  readonly controller = new SelectionToolbarController(this);
  get toolbar() {
    return this.controller.toolbar;
  }
  override connectedCallback() {
    super.connectedCallback();
    this.controller.connect();
    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (chrome)
      this.disposables.add(
        chrome.mountSelection(this, this.controller.controls),
      );
  }
}
