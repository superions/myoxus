import { PageViewportService } from "@virgultum/shared/services";

import type { MyoxusDragHandleWidget } from "../drag-handle.js";

export class PageWatcher {
  get pageViewportService() {
    return this.widget.std.get(PageViewportService);
  }

  constructor(readonly widget: MyoxusDragHandleWidget) {}

  watch() {
    const { disposables } = this.widget;

    disposables.add(
      this.pageViewportService.subscribe(() => {
        this.widget.hide();
      }),
    );
  }
}
