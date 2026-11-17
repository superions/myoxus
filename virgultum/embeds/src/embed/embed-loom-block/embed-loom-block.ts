import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import type { EmbedLoomModel, EmbedLoomStyles } from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import { BlockSelection } from "@virgultum/core/runtime";
import { property } from "lit/decorators.js";

import { EmbedBlockComponent } from "../common/embed-block-element.js";
import { loomUrlRegex } from "./embed-loom-model.js";
import type { EmbedLoomBlockService } from "./embed-loom-service.js";
import { refreshEmbedLoomUrlData } from "./utils.js";

export class EmbedLoomBlockComponent extends EmbedBlockComponent<
  EmbedLoomModel,
  EmbedLoomBlockService
> {
  override _cardStyle: (typeof EmbedLoomStyles)[number] = "video";

  open = () => {
    let link = this.model.props.url;
    if (!link.match(/^[a-zA-Z]+:\/\//)) {
      link = "https://" + link;
    }
    window.open(link, "_blank");
  };

  refreshData = () => {
    refreshEmbedLoomUrlData(this, this.fetchAbortController.signal).catch(
      console.error,
    );
  };

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

    if (!this.model.props.videoId) {
      this.store.withoutTransact(() => {
        const url = this.model.props.url;
        const urlMatch = url.match(loomUrlRegex);
        if (urlMatch) {
          const [, videoId] = urlMatch;
          this.store.updateBlock(this.model, {
            videoId,
          });
        }
      });
    }

    if (!this.model.props.description && !this.model.props.title) {
      this.store.withoutTransact(() => {
        this.refreshData();
      });
    }

    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        this.requestUpdate();
        if (key === "url") {
          this.refreshData();
        }
      }),
    );
  }

  override renderBlock() {
    const { image, title, description, videoId, url } = this.model.props;
    const imageProxy = this.store.get(ImageProxyService);
    return this.renderEmbed(
      () =>
        this.std.get(EditorChromeHostIdentifier).renderLoomCard({
          title: title ?? "Loom",
          description: description ?? null,
          image: image ? imageProxy.buildUrl(image) : null,
          videoId: videoId ?? null,
          url,
          loading: this.loading,
          selected: this.selected$.value,
          showOverlay: this.showOverlay$.value,
          select: (event) => this._handleClick(event),
          open: this.open,
        }),
      "native",
    );
  }

  @property({ attribute: false })
  accessor loading = false;
}
