import "@virgultum/core/commands";
import { effect } from "@preact/signals-core";
import type { ListBlockModel } from "@virgultum/core/models";
import { BlockSelection, TextSelection } from "@virgultum/core/runtime";
import type { BaseSelection } from "@virgultum/core/store";
import { playCheckAnimation } from "@virgultum/core/view/list-animation";
import { TextBlock } from "../../rich-text/text-block";
import type { RichText } from "../../rich-text/rich-text";
import { correctNumberedListsOrderToPrev } from "./commands/utils";
import { listBlockStyles } from "./styles";
import { updateListPrefix } from "./utils/get-list-prefix";

export class ListBlockComponent extends TextBlock<ListBlockModel> {
  protected readonly blockStyles = listBlockStyles;
  protected showDisclosure() {
    return this.model.children.length > 0;
  }
  private readonly _onClickPrefix = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (this.model.props.type === "toggle") {
      this.setCollapsed(!this.collapsed);
      return;
    } else if (this.model.props.type === "todo") {
      if (this.store.readonly) return;

      this.store.captureSync();
      const checkedPropObj = { checked: !this.model.props.checked };
      this.store.updateBlock(this.model, checkedPropObj);
      if (this.model.props.checked) {
        const checkEl = this.querySelector(".myoxus-list-block__todo-prefix");
        if (checkEl) {
          playCheckAnimation(checkEl).catch(console.error);
        }
      }
      return;
    }
    this._select();
  };

  private _select() {
    const selection = this.host.selection;
    selection.update((selList) => {
      return selList
        .filter<BaseSelection>(
          (sel) => !sel.is(TextSelection) && !sel.is(BlockSelection),
        )
        .concat(selection.create(BlockSelection, { blockId: this.blockId }));
    });
  }

  protected mountControls(
    _container: HTMLElement,
    line: HTMLElement,
    input: RichText,
  ) {
    const prefix = this.ownerDocument.createElement("div");
    prefix.addEventListener("click", this._onClickPrefix);
    line.insertBefore(prefix, input);
    this.disposables.add(
      effect(() => {
        updateListPrefix(prefix, this.model, !this.collapsed);
        line.classList.toggle(
          "myoxus-list--checked",
          this.model.props.type$.value === "todo" &&
            this.model.props.checked$.value,
        );
      }),
    );
    this.disposables.add(
      effect(() => {
        const type = this.model.props.type$.value;
        const order = this.model.props.order$.value;
        // old numbered list has no order
        if (type === "numbered" && !Number.isInteger(order)) {
          correctNumberedListsOrderToPrev(this.store, this.model, false);
        }
        // if list is not numbered, order should be null
        if (type !== "numbered" && order !== null) {
          this.model.props.order = null;
        }
      }),
    );
  }
}
