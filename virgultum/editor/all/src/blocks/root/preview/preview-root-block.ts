import type { RootBlockModel } from "@virgultum/core/models";
import { NativeContainerBlock } from "@virgultum/core/runtime";
import { visibleInPage } from "@virgultum/core/utils";

export class PreviewRootBlockComponent extends NativeContainerBlock<RootBlockModel> {
  protected readonly blockStyles = "myoxus-preview-root { display: block; }";

  protected mountBody() {
    const body = this.ownerDocument.createElement("div");
    body.className = "myoxus-preview-root";
    this.append(body);
    return body;
  }

  protected override projectedModels() {
    return this.model.children.filter(visibleInPage);
  }

  protected override afterProjection(body: HTMLElement) {
    this.mountBlockWidgets(body);
  }
}
