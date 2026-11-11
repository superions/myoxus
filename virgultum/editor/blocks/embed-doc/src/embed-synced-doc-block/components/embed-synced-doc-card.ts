import { RENDER_CARD_THROTTLE_MS } from "@virgultum/block-embed";
import { WithDisposable } from "@virgultum/global/lit";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
} from "@virgultum/shared/services";
import {
  BlockSelection,
  isGfxBlockComponent,
  ShadowlessElement,
} from "@virgultum/std";
import { html } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import throttle from "lodash-es/throttle";
import type { ObservedValueOf } from "rxjs";

import { renderLinkedDocInCard } from "../../common/render-linked-doc";
import type { EmbedSyncedDocBlockComponent } from "../embed-synced-doc-block.js";
import { cardStyles } from "../styles.js";

export class EmbedSyncedDocCard extends WithDisposable(ShadowlessElement) {
  static override styles = cardStyles;

  private _dragging = false;

  get blockState() {
    return this.block.blockState;
  }

  get editorMode() {
    return this.block.editorMode;
  }

  get host() {
    return this.block.host;
  }

  get linkedDoc() {
    return this.block.syncedDoc;
  }

  get model() {
    return this.block.model;
  }

  get std() {
    return this.block.std;
  }

  private _handleClick(event: MouseEvent) {
    event.stopPropagation();
    if (!isGfxBlockComponent(this.block)) {
      this._selectBlock();
    }
  }

  private _isDocEmpty() {
    const syncedDoc = this.block.syncedDoc;
    if (!syncedDoc) {
      return false;
    }
    return (
      !!syncedDoc &&
      !syncedDoc.meta?.title.length &&
      this.isNoteContentEmpty &&
      this.isBannerEmpty
    );
  }

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.block.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  override connectedCallback() {
    super.connectedCallback();

    // The card can unmount while its parent block continues as the full editor.
    this.disposables.add(
      this.std.event.add("dragStart", () => {
        this._dragging = true;
      }),
    );
    this.disposables.add(
      this.std.event.add("dragEnd", () => {
        this._dragging = false;
      }),
    );

    const { isCycle } = this.block.blockState;
    const syncedDoc = this.block.syncedDoc;
    if (isCycle && syncedDoc) {
      if (syncedDoc.root) {
        renderLinkedDocInCard(this);
      } else {
        const subscription = syncedDoc.slots.rootAdded.subscribe(() => {
          subscription.unsubscribe();
          renderLinkedDocInCard(this);
        });
        this.disposables.add(subscription);
      }

      this.disposables.add(
        syncedDoc.workspace.slots.docListUpdated.subscribe(() => {
          renderLinkedDocInCard(this);
        }),
      );
      // Both the subscription and its trailing callback belong to this card.
      const updatePreview = throttle(
        (payload: ObservedValueOf<typeof syncedDoc.slots.blockUpdated>) => {
          if (this._dragging) {
            return;
          }
          if (
            payload.type === "update" &&
            ["", "caption", "xywh"].includes(payload.props.key)
          ) {
            return;
          }
          renderLinkedDocInCard(this);
        },
        RENDER_CARD_THROTTLE_MS,
      );
      this.disposables.add(() => updatePreview.cancel());
      this.disposables.add(
        syncedDoc.slots.blockUpdated.subscribe(updatePreview),
      );
    }
  }

  // Preview writes may precede a concurrent React commit; keep both renderer targets stable.
  private readonly _noteElement = Object.assign(document.createElement("div"), {
    className: "myoxus-embed-synced-doc-content-note render",
  });
  private readonly _bannerElement = Object.assign(
    document.createElement("div"),
    {
      className: "myoxus-embed-synced-doc-card-banner render",
    },
  );
  private readonly _mountPreview = (container: HTMLDivElement | null) => {
    if (container && this._noteElement.parentElement !== container)
      container.replaceChildren(this._noteElement);
  };
  private readonly _mountBanner = (container: HTMLDivElement | null) => {
    if (container && this._bannerElement.parentElement !== container)
      container.replaceChildren(this._bannerElement);
  };

  override render() {
    const { isLoading, isDeleted, isError, isCycle } = this.blockState;
    const error = this.isError || isError;
    const inSurface = isGfxBlockComponent(this.block);
    const locale = this.std.getOptional(EditorI18nProvider)?.locale$.value;
    return html`<div
      class=${classMap({ "myoxus-embed-synced-doc-card": true, surface: inSurface })}
      @click=${this._handleClick}
    >
      ${this.std.get(EditorChromeHostIdentifier).renderDocumentCard({
        kind: "synced",
        title: this.block.title$.value ?? "",
        description: "",
        updated:
          !isLoading && !isDeleted && !error
            ? (this.block.docUpdatedAt?.toLocaleString(locale) ?? null)
            : null,
        loading: isLoading,
        error,
        unavailable: isDeleted,
        deleted: isDeleted,
        empty: this._isDocEmpty() && this.isBannerEmpty,
        nodeReference: false,
        selected: this.block.selected$.value || this.block.isCommentHighlighted,
        inSurface,
        variant: "horizontal",
        height: this.block._cardHeight,
        width: this.block._cardWidth,
        mountPreview: this._mountPreview,
        mountBanner: this._mountBanner,
        showBanner:
          isCycle && !isLoading && !isDeleted && !error && !this.isBannerEmpty,
        reload: () => this.block.refreshData(),
      })}
    </div>`;
  }

  get bannerContainer(): Promise<HTMLDivElement> {
    return this.updateComplete.then(() => this._bannerElement);
  }

  @property({ attribute: false })
  accessor block!: EmbedSyncedDocBlockComponent;

  @property({ attribute: false })
  accessor isBannerEmpty = false;

  @property({ attribute: false })
  accessor isError = false;

  @property({ attribute: false })
  accessor isNoteContentEmpty = false;

  get noteContainer(): Promise<HTMLDivElement> {
    return this.updateComplete.then(() => this._noteElement);
  }
}
