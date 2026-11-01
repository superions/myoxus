import type { RootBlockModel } from "@virgultum/model";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/std";
import { nothing } from "lit";
import { EditorChromeHostIdentifier } from "@virgultum/shared/services";
import { literal, unsafeStatic } from "lit/static-html.js";

import { ZoomController } from "./zoom-controller";

export const MYOXUS_EDGELESS_ZOOM_TOOLBAR_WIDGET =
  "myoxus-edgeless-zoom-toolbar-widget";

export class MyoxusEdgelessZoomToolbarWidget extends WidgetComponent<RootBlockModel> {
  get edgeless() {
    return this.block;
  }

  private controller!: ZoomController;

  override connectedCallback() {
    super.connectedCallback();
    this.controller = new ZoomController(this.std);
    this.disposables.add(() => this.controller.dispose());
    // The host only anchors chrome; native Mantine owns its visible styling.
    Object.assign(this.style, {
      position: "absolute",
      left: "var(--mantine-spacing-sm)",
      bottom: "var(--mantine-spacing-md)",
      zIndex: "var(--myoxus-z-index-popover)",
    });
  }

  override createRenderRoot() {
    return this;
  }

  override render() {
    return this.block
      ? (this.std
          .getOptional(EditorChromeHostIdentifier)
          ?.renderZoom(this.controller) ?? nothing)
      : nothing;
  }
}

export const edgelessZoomToolbarWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_EDGELESS_ZOOM_TOOLBAR_WIDGET,
  literal`${unsafeStatic(MYOXUS_EDGELESS_ZOOM_TOOLBAR_WIDGET)}`,
);
