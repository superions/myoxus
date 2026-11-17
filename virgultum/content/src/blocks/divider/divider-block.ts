import { CaptionedBlockComponent } from "../../caption/index";
import type { DividerBlockModel } from "@virgultum/core/models";
import { BLOCK_CHILDREN_CONTAINER_PADDING_LEFT } from "@virgultum/core/consts";
import { BlockSelection } from "@virgultum/core/runtime";
import { html } from "lit";

import { dividerBlockStyles } from "./styles";

export class DividerBlockComponent extends CaptionedBlockComponent<DividerBlockModel> {
  static override styles = dividerBlockStyles;

  override connectedCallback() {
    super.connectedCallback();

    this.contentEditable = "false";

    this.handleEvent("click", () => {
      this.host.selection.setGroup("note", [
        this.host.selection.create(BlockSelection, {
          blockId: this.blockId,
        }),
      ]);
    });
  }

  override renderBlock() {
    const children = html`<div
      class="myoxus-block-children-container"
      style="padding-left: ${BLOCK_CHILDREN_CONTAINER_PADDING_LEFT}px"
    >
      ${this.renderChildren(this.model)}
    </div>`;

    return html`
      <div class="myoxus-divider-block-container">
        <hr />

        ${children}
      </div>
    `;
  }

  override accessor useZeroWidth = true;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-divider": DividerBlockComponent;
  }
}
