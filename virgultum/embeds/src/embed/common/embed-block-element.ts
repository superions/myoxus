import { computed, effect, signal } from "@preact/signals-core";
import {
  NativeCaptionedBlockComponent,
  SelectedStyle,
  type BlockStyleMap,
} from "@virgultum/content/caption";
import type { EmbedCardStyle, EmbedProps } from "@virgultum/core/models";
import {
  EMBED_CARD_HEIGHT,
  EMBED_CARD_MIN_WIDTH,
  EMBED_CARD_WIDTH,
} from "@virgultum/core/consts";
import {
  BlockElementCommentManager,
  DocModeProvider,
} from "@virgultum/core/services";
import { findAncestorModel } from "@virgultum/core/utils";
import type { BlockService } from "@virgultum/core/runtime";
import {
  GfxViewInteractionExtension,
  type ResizeConstraint,
} from "@virgultum/core/runtime/gfx";
import type { BlockModel } from "@virgultum/core/store";

export abstract class EmbedBlockComponent<
  Model extends BlockModel<EmbedProps> = BlockModel<EmbedProps>,
  Service extends BlockService = BlockService,
  _WidgetName extends string = string,
> extends NativeCaptionedBlockComponent<Model, Service> {
  protected override useCaptionEditor = true;
  protected override useZeroWidth = true;

  protected showEditorSelection = true;
  protected embedSelectionMode: "editor" | "native" = "editor";

  readonly isDraggingOnHost$ = signal(false);
  readonly isResizing$ = signal(false);
  // show overlay to prevent the iframe from capturing pointer events
  // when the block is dragging, resizing, or not selected
  readonly showOverlay$ = computed(
    () =>
      this.isDraggingOnHost$.value ||
      this.isResizing$.value ||
      !this.selected$.value,
  );

  private _fetchAbortController = new AbortController();

  protected readonly _cardStyle$ = signal<EmbedCardStyle>("horizontal");
  protected readonly embedContainerStyle$ = signal<BlockStyleMap>({});

  blockDraggable = true;
  protected embedBlock!: HTMLDivElement;

  constructor() {
    super();
    this.selectedStyle$.value = SelectedStyle.Border;
    this.blockContainerStyles$.value = {
      margin: "18px 0",
    };
  }

  get _cardStyle(): EmbedCardStyle {
    return this._cardStyle$.value;
  }
  set _cardStyle(value: EmbedCardStyle) {
    this._cardStyle$.value = value;
  }

  get embedContainerStyle(): BlockStyleMap {
    return this.embedContainerStyle$.value;
  }
  set embedContainerStyle(value: BlockStyleMap) {
    this.embedContainerStyle$.value = value;
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  /**
   * The height of the current embed card. Changes based on the card style.
   */
  get _cardHeight() {
    return EMBED_CARD_HEIGHT[this._cardStyle$.value];
  }

  /**
   * The width of the current embed card. Changes based on the card style.
   */
  get _cardWidth() {
    return EMBED_CARD_WIDTH[this._cardStyle$.value];
  }

  get fetchAbortController() {
    return this._fetchAbortController;
  }

  protected abstract mountEmbedContent(container: HTMLElement): void;

  protected override mountBlock(container: HTMLElement) {
    if (this._fetchAbortController.signal.aborted)
      this._fetchAbortController = new AbortController();

    this.contentEditable = "false";

    // subscribe the editor host global dragging event
    // to show the overlay for the dragging area or other pointer events
    this.handleEvent(
      "dragStart",
      () => {
        this.isDraggingOnHost$.value = true;
      },
      { global: true },
    );

    this.handleEvent(
      "dragEnd",
      () => {
        this.isDraggingOnHost$.value = false;
      },
      { global: true },
    );

    const doc = this.ownerDocument;
    const embedContainer = doc.createElement("div");
    embedContainer.className = "embed-block-container";
    embedContainer.setAttribute(
      "draggable",
      this.blockDraggable ? "true" : "false",
    );
    this.embedBlock = embedContainer;
    container.replaceChildren(embedContainer);

    let appliedKeys: string[] = [];
    this.disposables.add(
      effect(() => {
        void this.revision$.value;
        const cardStyle = this._cardStyle$.value;
        if (
          cardStyle === "horizontal" ||
          cardStyle === "horizontalThin" ||
          cardStyle === "list"
        ) {
          this.style.display = "block";
          const insideNote = findAncestorModel(
            this.model,
            (m) => m.flavour === "myoxus:note",
          );
          if (
            !insideNote &&
            this.std.get(DocModeProvider).getEditorMode() === "edgeless"
          ) {
            this.style.minWidth = `${EMBED_CARD_MIN_WIDTH}px`;
          }
        }

        embedContainer.classList.toggle(
          "selected-style",
          this.embedSelectionMode === "editor" &&
            this.showEditorSelection &&
            this.selected$.value,
        );

        const nextStyle: BlockStyleMap = {
          height: `${EMBED_CARD_HEIGHT[cardStyle]}px`,
          width: "100%",
          ...(this.isCommentHighlighted
            ? { border: "2px solid var(--myoxus-primary-color)" }
            : {}),
          ...this.embedContainerStyle$.value,
        };

        for (const key of appliedKeys) {
          if (nextStyle[key] === undefined) {
            embedContainer.style.setProperty(
              key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
              "",
            );
          }
        }
        appliedKeys = [];
        for (const [key, value] of Object.entries(nextStyle)) {
          if (value !== undefined) {
            (embedContainer.style as unknown as Record<string, string>)[key] =
              value;
            appliedKeys.push(key);
          }
        }
      }),
    );

    this.mountEmbedContent(embedContainer);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._fetchAbortController.abort();
  }
}

export const createEmbedEdgelessBlockInteraction = (
  flavour: string,
  config?: {
    resizeConstraint?: ResizeConstraint;
  },
) => {
  const resizeConstraint = Object.assign(
    {
      lockRatio: true,
    },
    config?.resizeConstraint ?? {},
  );
  const rotateConstraint = {
    rotatable: false,
  };

  return GfxViewInteractionExtension(flavour, {
    resizeConstraint,
    handleRotate() {
      return {
        beforeRotate(context) {
          context.set(rotateConstraint);
        },
      };
    },
  });
};
