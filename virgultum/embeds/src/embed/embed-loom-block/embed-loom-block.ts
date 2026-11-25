import { computed, signal } from "@preact/signals-core";
import { EditorChromeHostIdentifier } from "@virgultum/core/services";
import type { EmbedLoomModel, EmbedLoomStyles } from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import { BlockSelection } from "@virgultum/core/runtime";

import { EmbedBlockComponent } from "../common/embed-block-element.js";
import { loomUrlRegex } from "./embed-loom-model.js";
import type { EmbedLoomBlockService } from "./embed-loom-service.js";
import { refreshEmbedLoomUrlData } from "./utils.js";

export class EmbedLoomBlockComponent extends EmbedBlockComponent<
  EmbedLoomModel,
  EmbedLoomBlockService
> {
  protected override embedSelectionMode = "native" as const;

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

  override get _cardStyle(): (typeof EmbedLoomStyles)[number] {
    return super._cardStyle as (typeof EmbedLoomStyles)[number];
  }
  override set _cardStyle(value: (typeof EmbedLoomStyles)[number]) {
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

  protected override mountEmbedContent(container: HTMLElement) {
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
      const { image, title, description, videoId, url } = this.model.props;
      const imageProxy = this.store.get(ImageProxyService);
      return {
        title: title ?? "Loom",
        description: description ?? null,
        image: image ? imageProxy.buildUrl(image) : null,
        videoId: videoId ?? null,
        url,
        loading: this._loading$.value,
        selected: this.selected$.value,
        showOverlay: this.showOverlay$.value,
        select: (event: MouseEvent) => this._handleClick(event),
        open: this.open,
      };
    });

    const unmount = chrome.mountLoomCard(host, state$);
    this.disposables.add(() => {
      unmount();
      host.remove();
    });
  }
}
