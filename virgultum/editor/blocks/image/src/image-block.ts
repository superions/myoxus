import { BrokenImageIcon, ImageIcon } from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { computed } from "@preact/signals-core";
import { CaptionedBlockComponent } from "@virgultum/components/caption";
import { whenHover } from "@virgultum/components/hover";
import { LoadingIcon } from "@virgultum/components/icons";
import { Peekable } from "@virgultum/components/peek";
import { ResourceController } from "@virgultum/components/resource";
import { IS_MOBILE } from "@virgultum/global/env";
import type { ImageBlockModel } from "@virgultum/model";
import { ImageSelection } from "@virgultum/shared/selection";
import {
  BlockElementCommentManager,
  ToolbarRegistryIdentifier,
} from "@virgultum/shared/services";
import { formatSize } from "@virgultum/shared/utils";
import { BlockSelection } from "@virgultum/std";
import { html } from "lit";
import { query } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { when } from "lit/directives/when.js";

import type { ImageBlockPageComponent } from "./components/page-image-block";
import {
  copyImageBlob,
  downloadImageBlob,
  refreshData,
  turnImageIntoCardView,
} from "./utils";

@Peekable({
  enableOn: () => !IS_MOBILE,
})
export class ImageBlockComponent extends CaptionedBlockComponent<ImageBlockModel> {
  resizeable$ = computed(() =>
    this.std.selection.value.some(
      (selection) =>
        selection.is(ImageSelection) && selection.blockId === this.blockId,
    ),
  );

  resourceController = new ResourceController(
    computed(() => this.model.props.sourceId$.value),
    "Image",
  );

  get blobUrl() {
    return this.resourceController.blobUrl$.value;
  }

  convertToCardView = () => {
    turnImageIntoCardView(this).catch(console.error);
  };

  copy = () => {
    copyImageBlob(this).catch(console.error);
  };

  download = () => {
    downloadImageBlob(this).catch(console.error);
  };

  refreshData = () => {
    refreshData(this).catch(console.error);
  };

  get resizableImg() {
    return this.pageImage?.resizeImg;
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  private _handleClick(event: MouseEvent) {
    // the peek view need handle shift + click
    if (event.defaultPrevented) return;

    event.stopPropagation();
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  private _initHover() {
    const { setReference, setFloating, dispose } = whenHover(
      (hovered) => {
        const message$ = this.std.get(ToolbarRegistryIdentifier).message$;
        if (hovered) {
          message$.value = {
            flavour: this.model.flavour,
            element: this,
            setFloating,
          };
          return;
        }

        // Clears previous bindings
        message$.value = null;
        setFloating();
      },
      { enterDelay: 500 },
    );
    setReference(this.hoverableContainer);
    this._disposables.add(dispose);
  }

  override connectedCallback() {
    super.connectedCallback();

    this.contentEditable = "false";

    this.resourceController.setEngine(this.std.store.blobSync);

    this.disposables.add(this.resourceController.subscribe());
    this.disposables.add(this.resourceController);

    this.disposables.add(
      this.model.props.sourceId$.subscribe(() => {
        this.refreshData();
      }),
    );
  }

  override firstUpdated() {
    // lazy bindings
    this.disposables.addFromEvent(this, "click", this._handleClick);
    this._initHover();
  }

  override renderBlock() {
    const blobUrl = this.blobUrl;
    const { size = 0 } = this.model.props;

    const containerStyleMap = styleMap({
      position: "relative",
      width: "100%",
    });

    const alignItemsStyleMap = styleMap({
      alignItems:
        this.model.props.textAlign$.value === "left"
          ? "flex-start"
          : this.model.props.textAlign$.value === "right"
            ? "flex-end"
            : undefined,
    });

    const resovledState = this.resourceController.resolveStateWith({
      loadingIcon: LoadingIcon({
        strokeColor: cssVar("pureWhite"),
        ringColor: cssVar("white60"),
      }),
      errorIcon: BrokenImageIcon(),
      icon: ImageIcon(),
      title: "Image",
      description: formatSize(size),
    });

    return html`
      <div class="myoxus-image-container" style=${containerStyleMap}>
        ${when(
          blobUrl,
          () =>
            html`<myoxus-page-image
              .block=${this}
              .state=${resovledState}
              style="${alignItemsStyleMap}"
            ></myoxus-page-image>`,
          () =>
            html`<myoxus-image-fallback-card
              .std=${this.std}
              .inSurface=${false}
              .state=${resovledState}
            ></myoxus-image-fallback-card>`,
        )}
      </div>

      ${Object.values(this.widgets)}
    `;
  }

  override accessor blockContainerStyles = { margin: "18px 0" };

  @query("myoxus-page-image")
  private accessor pageImage: ImageBlockPageComponent | null = null;

  @query(".myoxus-image-container")
  accessor hoverableContainer!: HTMLDivElement;

  override accessor useCaptionEditor = true;

  override accessor useZeroWidth = true;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-image": ImageBlockComponent;
  }
}
