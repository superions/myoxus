import { type FrameBlockModel } from "@virgultum/model";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/std";
import { html } from "lit";
import { literal, unsafeStatic } from "lit/static-html.js";

export const MYOXUS_FRAME_TITLE_WIDGET = "myoxus-frame-title-widget";

export class MyoxusFrameTitleWidget extends WidgetComponent<FrameBlockModel> {
  override render() {
    return html`<myoxus-frame-title
      .model=${this.model}
      data-id=${this.model.id}
    ></myoxus-frame-title>`;
  }
}

export const frameTitleWidget = WidgetViewExtension(
  "myoxus:frame",
  MYOXUS_FRAME_TITLE_WIDGET,
  literal`${unsafeStatic(MYOXUS_FRAME_TITLE_WIDGET)}`,
);
