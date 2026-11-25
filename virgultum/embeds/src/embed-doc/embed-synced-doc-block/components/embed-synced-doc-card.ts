import { computed, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { RENDER_CARD_THROTTLE_MS } from "../../../embed/index";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
} from "@virgultum/core/services";
import {
  BlockSelection,
  installEditorStyles,
  isGfxBlockComponent,
  NativeViewElement,
} from "@virgultum/core/runtime";
import throttle from "lodash-es/throttle";
import type { ObservedValueOf } from "rxjs";

import { renderLinkedDocInCard } from "../../common/render-linked-doc";
import type { EmbedSyncedDocBlockComponent } from "../embed-synced-doc-block.js";
import { cardStyles } from "../styles.js";

export class EmbedSyncedDocCard extends NativeViewElement {
  private _disposables = new DisposableGroup();
  private _dragging = false;
  private readonly _revision$ = signal(0);
  private readonly _isBannerEmpty$ = signal(false);
  private readonly _isError$ = signal(false);
  private readonly _isNoteContentEmpty$ = signal(false);

  block!: EmbedSyncedDocBlockComponent;

  get isBannerEmpty() {
    return this._isBannerEmpty$.value;
  }
  set isBannerEmpty(value: boolean) {
    this._isBannerEmpty$.value = value;
  }

  get isError() {
    return this._isError$.value;
  }
  set isError(value: boolean) {
    this._isError$.value = value;
  }

  get isNoteContentEmpty() {
    return this._isNoteContentEmpty$.value;
  }
  set isNoteContentEmpty(value: boolean) {
    this._isNoteContentEmpty$.value = value;
  }

  get updateComplete() {
    return Promise.resolve(this.isConnected);
  }

  requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

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

  private readonly _handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (!isGfxBlockComponent(this.block)) {
      this._selectBlock();
    }
  };

  private _isDocEmpty() {
    const syncedDoc = this.block.syncedDoc;
    if (!syncedDoc) {
      return false;
    }
    return (
      !!syncedDoc &&
      !syncedDoc.meta?.title.length &&
      this._isNoteContentEmpty$.value &&
      this._isBannerEmpty$.value
    );
  }

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.block.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
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

  connectedCallback() {
    installEditorStyles(this, cardStyles);
    this._disposables.dispose();
    this._disposables = new DisposableGroup();

    // The card can unmount while its parent block continues as the full editor.
    this._disposables.add(
      this.std.event.add("dragStart", () => {
        this._dragging = true;
      }),
    );
    this._disposables.add(
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
        this._disposables.add(subscription);
      }

      this._disposables.add(
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
      this._disposables.add(() => updatePreview.cancel());
      this._disposables.add(
        syncedDoc.slots.blockUpdated.subscribe(updatePreview),
      );
    }

    const doc = this.ownerDocument;
    const inSurface = isGfxBlockComponent(this.block);
    const wrapper = doc.createElement("div");
    wrapper.className = inSurface
      ? "myoxus-embed-synced-doc-card surface"
      : "myoxus-embed-synced-doc-card";
    this._disposables.addFromEvent(wrapper, "click", this._handleClick);

    const portalHost = doc.createElement("div");
    portalHost.style.display = "contents";
    wrapper.append(portalHost);
    this.replaceChildren(wrapper);

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;

    const state$ = computed(() => {
      void this._revision$.value;
      const { isLoading, isDeleted, isError, isCycle } = this.blockState;
      const error = this._isError$.value || isError;
      const locale = this.std.getOptional(EditorI18nProvider)?.locale$.value;
      return {
        kind: "synced" as const,
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
        empty: this._isDocEmpty() && this._isBannerEmpty$.value,
        nodeReference: false,
        selected: this.block.selected$.value || this.block.isCommentHighlighted,
        inSurface,
        variant: "horizontal" as const,
        height: this.block._cardHeight,
        width: this.block._cardWidth,
        mountPreview: this._mountPreview,
        mountBanner: this._mountBanner,
        showBanner:
          isCycle &&
          !isLoading &&
          !isDeleted &&
          !error &&
          !this._isBannerEmpty$.value,
        reload: () => this.block.refreshData(),
      };
    });

    const unmount = chrome.mountDocumentCard(portalHost, state$);
    this._disposables.add(() => {
      unmount();
      portalHost.remove();
    });
  }

  disconnectedCallback() {
    this._disposables.dispose();
  }

  get bannerContainer(): Promise<HTMLDivElement> {
    return this.updateComplete.then(() => this._bannerElement);
  }

  get noteContainer(): Promise<HTMLDivElement> {
    return this.updateComplete.then(() => this._noteElement);
  }
}
