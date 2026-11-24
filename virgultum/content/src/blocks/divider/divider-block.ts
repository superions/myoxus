import { selectionFrame } from "../../caption/selection-frame";
import type { DividerBlockModel } from "@virgultum/core/models";
import { BLOCK_CHILDREN_CONTAINER_PADDING_LEFT } from "@virgultum/core/consts";
import { BlockSelection, NativeContainerBlock } from "@virgultum/core/runtime";

import { dividerBlockStyles } from "./styles";

export class DividerBlockComponent extends NativeContainerBlock<DividerBlockModel> {
  protected readonly blockStyles = dividerBlockStyles;

  protected mountBody() {
    this.contentEditable = "false";

    this.handleEvent("click", () => {
      this.host.selection.setGroup("note", [
        this.host.selection.create(BlockSelection, {
          blockId: this.blockId,
        }),
      ]);
    });
    const doc = this.ownerDocument;
    const container = doc.createElement("div");
    container.className = "myoxus-divider-block-container";
    const children = doc.createElement("div");
    children.className = "myoxus-block-children-container";
    children.style.paddingLeft = BLOCK_CHILDREN_CONTAINER_PADDING_LEFT + "px";
    container.append(doc.createElement("hr"), children);
    this.append(selectionFrame(this, container, true));
    return children;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-divider": DividerBlockComponent;
  }
}
