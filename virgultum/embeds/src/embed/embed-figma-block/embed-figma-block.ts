import { computed } from "@preact/signals-core";
import type { EmbedFigmaModel, EmbedFigmaStyles } from "@virgultum/core/models";
import { BlockSelection } from "@virgultum/core/runtime";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";

import { EmbedBlockComponent } from "../common/embed-block-element.js";

export class EmbedFigmaBlockComponent extends EmbedBlockComponent<EmbedFigmaModel> {
  protected override embedSelectionMode = "native" as const;

  constructor() {
    super();
    this._cardStyle$.value = "figma";
  }

  override get _cardStyle(): (typeof EmbedFigmaStyles)[number] {
    return super._cardStyle as (typeof EmbedFigmaStyles)[number];
  }
  override set _cardStyle(value: (typeof EmbedFigmaStyles)[number]) {
    super._cardStyle = value;
  }

  open = () => {
    let link = this.model.props.url;
    if (!link.match(/^[a-zA-Z]+:\/\//)) {
      link = "https://" + link;
    }
    window.open(link, "_blank");
  };

  refreshData = () => {};

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  protected _handleClick(event: MouseEvent) {
    event.stopPropagation();
    this._selectBlock();
  }

  protected override mountEmbedContent(container: HTMLElement) {
    this._cardStyle = this.model.props.style;

    if (!this.model.props.title) {
      this.store.withoutTransact(() => {
        this.store.updateBlock(this.model, {
          title: "Figma",
        });
      });
    }

    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === "style") {
          this._cardStyle = this.model.props.style;
        }
        if (key === "url") {
          this.refreshData();
        }
      }),
    );

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;

    const host = this.ownerDocument.createElement("div");
    host.style.display = "contents";
    container.replaceChildren(host);

    const state$ = computed(() => {
      void this.revision$.value;
      const { title, description, url } = this.model.props;
      return {
        title: title ?? "Figma",
        description: description ?? null,
        url,
        iframeUrl: `https://www.figma.com/embed?embed_host=virgultum&url=${url}`,
        selected: this.selected$.value,
        showOverlay: this.showOverlay$.value,
        select: (event: MouseEvent) => this._handleClick(event),
        open: this.open,
      };
    });

    const unmount = chrome.mountFigmaCard(host, state$);
    this.disposables.add(() => {
      unmount();
      host.remove();
    });
  }
}
