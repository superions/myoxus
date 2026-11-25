import { computed, effect, untracked } from "@preact/signals-core";
import { NativeCaptionedBlockComponent } from "@virgultum/content/caption";
import { whenHover } from "@virgultum/core/view/hover";
import { Peekable } from "@virgultum/core/view/peek";
import { ResourceController } from "@virgultum/core/resource";
import { IS_MOBILE } from "@virgultum/core/primitives/env";
import type { ImageBlockModel } from "@virgultum/core/models";
import { ImageSelection } from "@virgultum/core/selection";
import {
  BlockElementCommentManager,
  ToolbarRegistryIdentifier,
} from "@virgultum/core/services";
import { formatSize } from "@virgultum/core/utils";
import { BlockSelection } from "@virgultum/core/runtime";

import type { ImageBlockFallbackCard } from "./components/image-fallback";
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
export class ImageBlockComponent extends NativeCaptionedBlockComponent<ImageBlockModel> {
  protected override useCaptionEditor = true;
  protected override useZeroWidth = true;

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

  hoverableContainer!: HTMLDivElement;
  private pageImage: ImageBlockPageComponent | null = null;

  constructor() {
    super();
    this.blockContainerStyles$.value = { margin: "18px 0" };
  }

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

  private readonly _handleClick = (event: MouseEvent) => {
    // the peek view need handle shift + click
    if (event.defaultPrevented) return;

    event.stopPropagation();
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  };

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
    this.disposables.add(dispose);
  }

  protected override mountBlock(container: HTMLElement) {
    this.contentEditable = "false";

    this.resourceController.setEngine(this.std.store.blobSync);

    this.disposables.add(this.resourceController.subscribe());
    this.disposables.add(this.resourceController);

    this.disposables.add(
      this.model.props.sourceId$.subscribe(() => {
        this.refreshData();
      }),
    );

    const doc = this.ownerDocument;
    const imageContainer = doc.createElement("div");
    imageContainer.className = "myoxus-image-container";
    imageContainer.style.position = "relative";
    imageContainer.style.width = "100%";
    this.hoverableContainer = imageContainer;

    container.replaceChildren(imageContainer);
    this.mountBlockWidgets(container);

    this.disposables.addFromEvent(this, "click", this._handleClick);
    this._initHover();

    const resolvedState$ = computed(() => {
      void this.revision$.value;
      const { size = 0 } = this.model.props;
      return this.resourceController.resolveStateWith({
        title: "Image",
        description: formatSize(size),
      });
    });

    let fallbackCard: ImageBlockFallbackCard | null = null;

    this.disposables.add(
      effect(() => {
        const blobUrl = this.blobUrl;
        const resolvedState = resolvedState$.value;
        const textAlign = this.model.props.textAlign$.value;

        untracked(() => {
          if (blobUrl) {
            fallbackCard = null;
            if (!this.pageImage) {
              const pageImage = doc.createElement(
                "myoxus-page-image",
              ) as ImageBlockPageComponent;
              pageImage.block = this;
              pageImage.state = resolvedState;
              this.pageImage = pageImage;
              imageContainer.replaceChildren(pageImage);
            } else {
              this.pageImage.state = resolvedState;
              this.pageImage.requestUpdate();
            }
            this.pageImage.style.alignItems =
              textAlign === "left"
                ? "flex-start"
                : textAlign === "right"
                  ? "flex-end"
                  : "";
            return;
          }

          this.pageImage = null;
          if (!fallbackCard) {
            fallbackCard = doc.createElement(
              "myoxus-image-fallback-card",
            ) as ImageBlockFallbackCard;
            fallbackCard.std = this.std;
            fallbackCard.inSurface = false;
            fallbackCard.state = resolvedState;
            imageContainer.replaceChildren(fallbackCard);
          } else {
            fallbackCard.state = resolvedState;
          }
        });
      }),
    );
  }

  override disconnectedCallback() {
    this.pageImage = null;
    super.disconnectedCallback();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-image": ImageBlockComponent;
  }
}
