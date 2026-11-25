import { effect, untracked } from "@preact/signals-core";
import { toEdgelessEmbedBlock } from "../../embed/index";
import {
  EdgelessCRUDIdentifier,
  reassociateConnectorsCommand,
} from "@virgultum/canvas-runtime/surface";
import { Bound } from "@virgultum/core/primitives/gfx";
import { type AliasInfo, type DocMode } from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import {
  ThemeExtensionIdentifier,
  ThemeProvider,
  editorMessage,
} from "@virgultum/core/services";
import { type BlockComponent, BlockStdScope } from "@virgultum/core/runtime";
import type { Store } from "@virgultum/core/store";

import { HeightInitializationExtension } from "./init-height-extension";
import { EmbedSyncedDocConfigExtension } from "./configs";
import { EmbedSyncedDocBlockComponent } from "./embed-synced-doc-block";

export class EmbedEdgelessSyncedDocBlockComponent extends toEdgelessEmbedBlock(
  EmbedSyncedDocBlockComponent,
) {
  protected override useCaptionEditor = true;

  get headerWrapper(): HTMLDivElement | null {
    return this.querySelector<HTMLDivElement>(
      ".myoxus-embed-synced-doc-edgeless-header-wrapper",
    );
  }

  get contentElement(): BlockComponent | null {
    return this.querySelector<BlockComponent>("myoxus-preview-root");
  }

  protected override mountSyncedView(container: HTMLElement): () => void {
    const doc = this.ownerDocument;
    const outer = doc.createElement("div");
    const onClick = (e: MouseEvent) => this._handleClick(e);
    outer.addEventListener("click", onClick);

    const headerWrapper = doc.createElement("div");
    headerWrapper.className = "myoxus-embed-synced-doc-edgeless-header-wrapper";
    const headerPortalHost = doc.createElement("div");
    headerPortalHost.style.display = "contents";
    headerWrapper.append(headerPortalHost);

    const editorEl = doc.createElement("div");
    editorEl.className = "myoxus-embed-synced-doc-editor";

    const overlay = doc.createElement("div");
    overlay.className = "myoxus-embed-synced-doc-editor-overlay";

    outer.append(headerWrapper, editorEl, overlay);
    container.replaceChildren(outer);

    const unmountHeader = this.std
      .getOptional(EmbedSyncedDocConfigExtension.identifier)
      ?.mountEdgelessHeader(headerPortalHost, {
        model: this.model,
        std: this.std,
      });

    let mountedEditorKey: {
      mode: DocMode;
      doc: Store;
      viewport: HTMLDivElement;
    } | null = null;

    const stopEffect = effect(() => {
      void this.revision$.value;
      const syncedDoc = this.syncedDoc;
      const editorMode = this.editorMode;
      if (!syncedDoc) {
        console.error("Synced doc is not found");
        return;
      }

      const modelScale = this.model.props.scale$.value ?? 1;
      const bound = Bound.deserialize(this.model.props.xywh$.value);
      const width = bound.w / modelScale;
      const height = bound.h / modelScale;

      const themeService = this.std.get(ThemeProvider);
      const themeExtension = this.std.getOptional(ThemeExtensionIdentifier);
      const appTheme = themeService.app$.value;
      let edgelessTheme = themeService.edgeless$.value;
      if (themeExtension?.getEdgelessTheme && syncedDoc.id) {
        edgelessTheme = themeExtension.getEdgelessTheme(syncedDoc.id).value;
      }
      const theme = this.isPageMode ? appTheme : edgelessTheme;
      const selected = this.selected$.value;
      const isEmpty = this.isPageMode && this._isEmptySyncedDoc$.value;

      untracked(() => {
        this.dataset.nestedEditor = "";
        outer.className = [
          "myoxus-embed-synced-doc-container",
          editorMode,
          theme,
          "surface",
          selected ? "selected" : "",
        ]
          .filter(Boolean)
          .join(" ");

        Object.assign(outer.style, {
          width: `${width}px`,
          height: `${height}px`,
          minHeight: `${height}px`,
          transform: `scale(${modelScale})`,
          transformOrigin: "0 0",
        });

        if (modelScale) {
          outer.setAttribute("data-scale", "");
        } else {
          outer.removeAttribute("data-scale");
        }

        if (isEmpty) {
          mountedEditorKey = null;
          const empty = doc.createElement("div");
          empty.className = "myoxus-embed-synced-doc-editor-empty";
          const span = doc.createElement("span");
          span.textContent = this._text(
            editorMessage(
              "com.myoxus.editor.embed.synced-empty-hint",
              "This is a linked doc, you can add content here.",
            ),
          );
          empty.append(span);
          editorEl.replaceChildren(empty);
        } else if (
          !mountedEditorKey ||
          mountedEditorKey.mode !== editorMode ||
          mountedEditorKey.doc !== syncedDoc
        ) {
          const viewport = doc.createElement("div");
          viewport.className =
            editorMode === "page"
              ? "myoxus-page-viewport"
              : "myoxus-edgeless-viewport";
          viewport.dataset.theme =
            editorMode === "page" ? appTheme : edgelessTheme;
          const preview = new BlockStdScope({
            store: syncedDoc,
            extensions: this._buildPreviewSpec(
              editorMode === "page" ? "preview-page" : "preview-edgeless",
            ),
          }).render();
          if (editorMode === "page") {
            void this.std
              .getOptional(HeightInitializationExtension)
              ?.fitPreview(this, preview)
              .catch(console.error);
          }
          viewport.append(preview);
          mountedEditorKey = { mode: editorMode, doc: syncedDoc, viewport };
          editorEl.replaceChildren(viewport);
        } else {
          mountedEditorKey.viewport.dataset.theme =
            editorMode === "page" ? appTheme : edgelessTheme;
        }
      });
    });

    return () => {
      stopEffect();
      outer.removeEventListener("click", onClick);
      unmountHeader?.();
      headerPortalHost.remove();
      outer.remove();
    };
  }

  override convertToCard = (aliasInfo?: AliasInfo) => {
    const { id, store, xywh } = this.model;
    const { caption } = this.model.props;

    const style = "vertical";
    const bound = Bound.deserialize(xywh);
    bound.w = EMBED_CARD_WIDTH[style];
    bound.h = EMBED_CARD_HEIGHT[style];

    const { addBlock } = this.std.get(EdgelessCRUDIdentifier);
    const surface = this.gfx.surface ?? undefined;
    const newId = addBlock(
      "myoxus:embed-linked-doc",
      {
        xywh: bound.serialize(),
        style,
        caption,
        ...this.referenceInfo,
        ...aliasInfo,
      },
      surface,
    );

    this.std.command.exec(reassociateConnectorsCommand, {
      oldId: id,
      newId,
    });

    this.gfx.selection.set({
      editing: false,
      elements: [newId],
    });
    store.deleteBlock(this.model);
  };

  override syncGfxLayout() {
    const { style, xywh$ } = this.model.props;
    const bound = Bound.deserialize(xywh$.value);

    this.embedContainerStyle$.value = {
      ...this.embedContainerStyle$.peek(),
      width: `${bound.w}px`,
      height: `${bound.h}px`,
    };
    this.blockContainerStyles$.value = {
      width: `${bound.w}px`,
    };
    this.cardStyleMap$.value = {
      display: "block",
      width: `${EMBED_CARD_WIDTH[style]}px`,
      height: `${EMBED_CARD_HEIGHT[style]}px`,
      transform: `scale(${bound.w / EMBED_CARD_WIDTH[style]}, ${bound.h / EMBED_CARD_HEIGHT[style]})`,
      transformOrigin: "0 0",
    };
  }
}
