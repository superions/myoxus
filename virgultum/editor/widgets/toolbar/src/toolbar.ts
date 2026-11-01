import { nothing } from "lit";
import { WidgetComponent } from "@virgultum/std";
import { EditorChromeHostIdentifier } from "@virgultum/shared/services";
import { SelectionToolbarController } from "./selection-controller";

export const MYOXUS_TOOLBAR_WIDGET = "myoxus-toolbar-widget";

export class MyoxusToolbarWidget extends WidgetComponent {
  override createRenderRoot() {
    return this;
  }
  readonly controller = new SelectionToolbarController(this);
  get toolbar() {
    return this.controller.toolbar;
  }
  override render() {
    return (
      this.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderSelection(this.controller.controls) ?? nothing
    );
  }
  override connectedCallback() {
    super.connectedCallback();
    this.controller.connect();
  }
}
