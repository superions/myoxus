import { stopPropagation } from "@virgultum/core/utils";
import {
  type BlockComponent,
  NativeViewElement,
  TextSelection,
} from "@virgultum/core/runtime";
export class BlockZeroWidth extends NativeViewElement {
  private static readonly styles = `
    .block-zero-width {
      position: absolute;
      bottom: -15px;
      height: 10px;
      width: 100%;
      cursor: text;
      z-index: 1;
    }
  `;

  _handleClick = (e: MouseEvent) => {
    stopPropagation(e);
    if (this.block.store.readonly) return;
    const nextBlock = this.block.store.getNext(this.block.model);
    if (nextBlock?.flavour !== "myoxus:paragraph") {
      const [paragraphId] = this.block.store.addSiblingBlocks(
        this.block.model,
        [{ flavour: "myoxus:paragraph" }],
      );
      const std = this.block.std;
      std.selection.setGroup("note", [
        std.selection.create(TextSelection, {
          from: { blockId: paragraphId, index: 0, length: 0 },
          to: null,
        }),
      ]);
    }
  };

  block!: BlockComponent;

  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = BlockZeroWidth.styles;
    const hitTarget = this.ownerDocument.createElement("div");
    hitTarget.className = "block-zero-width";
    root.append(style, hitTarget);
    this.addEventListener("click", this._handleClick);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "block-zero-width": BlockZeroWidth;
  }
}
