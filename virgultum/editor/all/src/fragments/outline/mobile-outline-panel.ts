import { signal } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/core/primitives/lit";
import {
  NoteDisplayMode,
  ParagraphBlockModel,
  RootBlockModel,
} from "@virgultum/core/models";
import {
  DocModeProvider,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { matchModels } from "@virgultum/core/utils";
import {
  type EditorHost,
  PropTypes,
  requiredProperties,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import type { BlockModel } from "@virgultum/core/store";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { getHeadingBlocksFromDoc } from "./utils/query.js";
import {
  observeActiveHeadingDuringScroll,
  scrollToBlockWithHighlight,
} from "./utils/scroll.js";

export const MYOXUS_MOBILE_OUTLINE_MENU = "myoxus-mobile-outline-menu";

@requiredProperties({
  editor: PropTypes.object,
})
export class MobileOutlineMenu extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private readonly _activeHeadingId$ = signal<string | null>(null);

  private _highlightMaskDisposable = () => {};

  private _lockActiveHeadingId = false;

  private async _scrollToBlock(blockId: string) {
    this._lockActiveHeadingId = true;
    this._activeHeadingId$.value = blockId;
    this._highlightMaskDisposable = await scrollToBlockWithHighlight(
      this.editor,
      blockId,
    );
    this._lockActiveHeadingId = false;
  }

  override connectedCallback() {
    super.connectedCallback();

    this.disposables.add(
      observeActiveHeadingDuringScroll(
        () => this.editor,
        (newHeadingId) => {
          if (this._lockActiveHeadingId) return;
          this._activeHeadingId$.value = newHeadingId;
        },
      ),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._highlightMaskDisposable();
  }

  renderItem = (item: BlockModel) => {
    const root = matchModels(item, [RootBlockModel]);
    const heading =
      matchModels(item, [ParagraphBlockModel]) &&
      ["h1", "h2", "h3", "h4", "h5", "h6"].includes(item.props.type$.value);
    if (!root && !heading) return nothing;
    return (
      this.editor.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderOutlineEntry({
          entry: {
            id: item.id,
            label: root
              ? item.props.title$.value.toString()
              : item.props.text$.value.toString(),
            level: root
              ? 0
              : Math.max(0, Number(item.props.type$.value.slice(1)) - 1),
            icon: "PageIcon",
          },
          active: this._activeHeadingId$.value === item.id,
          showIcon: false,
          activate: () => {
            this._scrollToBlock(item.id).catch(console.error);
          },
        }) ?? nothing
    );
  };

  override render() {
    const docModeService = this.editor.std.get(DocModeProvider);
    const mode = docModeService.getEditorMode();
    if (this.editor.store.root === null || mode === "edgeless") return nothing;

    const headingBlocks = getHeadingBlocksFromDoc(
      this.editor.store,
      [NoteDisplayMode.DocAndEdgeless, NoteDisplayMode.DocOnly],
      true,
    );

    if (headingBlocks.length === 0) return nothing;

    const items = [
      ...(this.editor.store.meta?.title !== "" ? [this.editor.store.root] : []),
      ...headingBlocks,
    ];

    return repeat(items, (block) => block.id, this.renderItem);
  }

  @property({ attribute: false })
  accessor editor!: EditorHost;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_MOBILE_OUTLINE_MENU]: MobileOutlineMenu;
  }
}
