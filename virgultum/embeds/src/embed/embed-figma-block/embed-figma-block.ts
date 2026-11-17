import type { EmbedFigmaModel, EmbedFigmaStyles } from "@virgultum/core/models";
import { BlockSelection } from "@virgultum/core/runtime";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";

import { EmbedBlockComponent } from "../common/embed-block-element.js";

export class EmbedFigmaBlockComponent extends EmbedBlockComponent<EmbedFigmaModel> {
  override _cardStyle: (typeof EmbedFigmaStyles)[number] = "figma";

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

  override connectedCallback() {
    super.connectedCallback();
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
        if (key === "url") {
          this.refreshData();
        }
      }),
    );
  }

  override renderBlock() {
    const { title, description, url } = this.model.props;
    return this.renderEmbed(
      () =>
        this.std.get(EditorChromeHostIdentifier).renderFigmaCard({
          title: title ?? "Figma",
          description: description ?? null,
          url,
          iframeUrl: `https://www.figma.com/embed?embed_host=virgultum&url=${url}`,
          selected: this.selected$.value,
          showOverlay: this.showOverlay$.value,
          select: (event) => this._handleClick(event),
          open: this.open,
        }),
      "native",
    );
  }
}
