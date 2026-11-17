import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import type {
  EmbedYoutubeModel,
  EmbedYoutubeStyles,
} from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import { BlockSelection } from "@virgultum/core/runtime";
import { property, state } from "lit/decorators.js";
import { EmbedBlockComponent } from "../common/embed-block-element.js";
import { youtubeUrlRegex } from "./embed-youtube-model.js";
import type { EmbedYoutubeBlockService } from "./embed-youtube-service.js";
import { refreshEmbedYoutubeUrlData } from "./utils.js";

export class EmbedYoutubeBlockComponent extends EmbedBlockComponent<
  EmbedYoutubeModel,
  EmbedYoutubeBlockService
> {
  override _cardStyle: (typeof EmbedYoutubeStyles)[number] = "video";

  open = () => {
    let link = this.model.props.url;
    if (!link.match(/^[a-zA-Z]+:\/\//)) {
      link = "https://" + link;
    }
    window.open(link, "_blank");
  };

  refreshData = () => {
    refreshEmbedYoutubeUrlData(this, this.fetchAbortController.signal).catch(
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
        const urlMatch = url.match(youtubeUrlRegex);
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

    const print = matchMedia("print");
    this._showImage = print.matches;
    this.disposables.addFromEvent(print, "change", () => {
      this._showImage = print.matches;
    });
  }

  override renderBlock() {
    const { image, title, description, creator, creatorImage, videoId, url } =
      this.model.props;
    const proxy = this.store.get(ImageProxyService);
    return this.renderEmbed(
      () =>
        this.std.get(EditorChromeHostIdentifier).renderYoutubeCard({
          title: title ?? "YouTube",
          description: description ?? null,
          creator: creator ?? null,
          creatorImage: creatorImage ? proxy.buildUrl(creatorImage) : null,
          image: image ? proxy.buildUrl(image) : null,
          videoId: videoId ?? null,
          url,
          loading: this.loading,
          printImage: this._showImage,
          selected: this.selected$.value,
          showOverlay: this.showOverlay$.value,
          select: (event) => this._handleClick(event),
          open: this.open,
        }),
      "native",
    );
  }

  @state()
  private accessor _showImage = false;

  @property({ attribute: false })
  accessor loading = false;
}
