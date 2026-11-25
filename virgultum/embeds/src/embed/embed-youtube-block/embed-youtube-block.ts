import { computed, signal } from "@preact/signals-core";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import type {
  EmbedYoutubeModel,
  EmbedYoutubeStyles,
} from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import { BlockSelection } from "@virgultum/core/runtime";
import { EmbedBlockComponent } from "../common/embed-block-element.js";
import { youtubeUrlRegex } from "./embed-youtube-model.js";
import type { EmbedYoutubeBlockService } from "./embed-youtube-service.js";
import { refreshEmbedYoutubeUrlData } from "./utils.js";

export class EmbedYoutubeBlockComponent extends EmbedBlockComponent<
  EmbedYoutubeModel,
  EmbedYoutubeBlockService
> {
  protected override embedSelectionMode = "native" as const;

  private readonly _showImage$ = signal(false);
  private readonly _loading$ = signal(false);

  constructor() {
    super();
    this._cardStyle$.value = "video";
  }

  get loading() {
    return this._loading$.value;
  }
  set loading(value: boolean) {
    this._loading$.value = value;
  }

  override get _cardStyle(): (typeof EmbedYoutubeStyles)[number] {
    return super._cardStyle as (typeof EmbedYoutubeStyles)[number];
  }
  override set _cardStyle(value: (typeof EmbedYoutubeStyles)[number]) {
    super._cardStyle = value;
  }

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

  protected override mountEmbedContent(container: HTMLElement) {
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
        if (key === "style") {
          this._cardStyle = this.model.props.style;
        }
        if (key === "url") {
          this.refreshData();
        }
      }),
    );

    const print = matchMedia("print");
    this._showImage$.value = print.matches;
    this.disposables.addFromEvent(print, "change", () => {
      this._showImage$.value = print.matches;
    });

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;

    const host = this.ownerDocument.createElement("div");
    host.style.display = "contents";
    container.replaceChildren(host);

    const state$ = computed(() => {
      void this.revision$.value;
      const { image, title, description, creator, creatorImage, videoId, url } =
        this.model.props;
      const proxy = this.store.get(ImageProxyService);
      return {
        title: title ?? "YouTube",
        description: description ?? null,
        creator: creator ?? null,
        creatorImage: creatorImage ? proxy.buildUrl(creatorImage) : null,
        image: image ? proxy.buildUrl(image) : null,
        videoId: videoId ?? null,
        url,
        loading: this._loading$.value,
        printImage: this._showImage$.value,
        selected: this.selected$.value,
        showOverlay: this.showOverlay$.value,
        select: (event: MouseEvent) => this._handleClick(event),
        open: this.open,
      };
    });

    const unmount = chrome.mountYoutubeCard(host, state$);
    this.disposables.add(() => {
      unmount();
      host.remove();
    });
  }
}
