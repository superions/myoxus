import { computed, effect } from "@preact/signals-core";
import {
  AttachmentBlockModel,
  BookmarkBlockModel,
  CodeBlockModel,
  DatabaseBlockModel,
  ImageBlockModel,
  SurfaceRefBlockModel,
} from "@virgultum/core/models";
import { getSelectionRectsCommand } from "@virgultum/core/commands";
import { EMBED_BLOCK_MODEL_LIST } from "@virgultum/core/consts";
import { matchModels } from "@virgultum/core/utils";
import {
  BlockSelection,
  TextSelection,
  NativeEditorWidget,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  mountDocRemotePresenceOverlay,
  type DocRemotePeerSnapshot,
  type DocRemotePresenceHandle,
  type OverlayRect,
} from "@virgultum/core/services";
import type { BaseSelection, UserInfo } from "@virgultum/core/store";
import throttle from "lodash-es/throttle";

import type { DocRemoteSelectionConfig } from "./config";

export interface SelectionRect {
  width: number;
  height: number;
  top: number;
  left: number;
  transparent?: boolean;
}

export const MYOXUS_DOC_REMOTE_SELECTION_WIDGET =
  "myoxus-doc-remote-selection-widget";

export class MyoxusDocRemoteSelectionWidget extends NativeEditorWidget {
  private _overlay: DocRemotePresenceHandle | null = null;

  private _selections: Array<{
    id: number;
    selections: BaseSelection[];
    rects: SelectionRect[];
    user?: UserInfo;
  }> = [];

  private readonly _remoteSelections = computed(() => {
    const status = this.store.awarenessStore.getStates();
    return [...this.std.selection.remoteSelections.entries()].map(
      ([id, selections]) => ({
        id,
        selections,
        user: status.get(id)?.user,
      }),
    );
  });

  private readonly _resizeObserver: ResizeObserver = new ResizeObserver(() => {
    this._overlay?.schedulePaint();
  });

  private get _config(): DocRemoteSelectionConfig {
    return {
      blockSelectionBackgroundTransparent: (block) =>
        matchModels(block, [
          CodeBlockModel,
          DatabaseBlockModel,
          ImageBlockModel,
          AttachmentBlockModel,
          BookmarkBlockModel,
          SurfaceRefBlockModel,
          ...EMBED_BLOCK_MODEL_LIST,
        ]),
    };
  }

  private get _container() {
    return this.offsetParent;
  }

  private get _containerRect() {
    return this.offsetParent?.getBoundingClientRect();
  }

  private get _selectionManager() {
    return this.host.selection;
  }

  private _getTextRange(textSelection: TextSelection): Range | null {
    const toBlockId = textSelection.to
      ? textSelection.to.blockId
      : textSelection.from.blockId;

    let range = this.std.range.textSelectionToRange(
      this._selectionManager.create(TextSelection, {
        from: {
          blockId: toBlockId,
          index: textSelection.to
            ? textSelection.to.index + textSelection.to.length
            : textSelection.from.index + textSelection.from.length,
          length: 0,
        },
        to: null,
      }),
    );

    if (!range) {
      const block = this.std.view.getBlock(toBlockId);
      if (!block) return null;

      range = this.std.range.textSelectionToRange(
        this._selectionManager.create(TextSelection, {
          from: {
            blockId: toBlockId,
            index: block.model.text?.length ?? 0,
            length: 0,
          },
          to: null,
        }),
      );

      if (!range) return null;
    }

    return range;
  }

  private _getCursorInfo(
    selections: BaseSelection[],
  ): { rect: OverlayRect; blockId: string | null } | null {
    if (!this.block || this.block.model.flavour !== "myoxus:page") {
      return null;
    }

    const textSelection = selections.find(
      (selection) => selection instanceof TextSelection,
    ) as TextSelection | undefined;
    const blockSelections = selections.filter(
      (selection) => selection instanceof BlockSelection,
    );
    const container = this._container;
    const containerRect = this._containerRect;

    if (textSelection) {
      const range = this._getTextRange(textSelection);
      if (!range) return null;
      const rangeRects = Array.from(range.getClientRects());
      if (rangeRects.length > 0) {
        const rect =
          rangeRects.length === 1
            ? rangeRects[0]
            : rangeRects[rangeRects.length - 1];
        const blockId = textSelection.to
          ? textSelection.to.blockId
          : textSelection.from.blockId;
        return {
          blockId,
          rect: {
            width: 3,
            height: rect.height,
            top:
              rect.top -
              (containerRect?.top ?? 0) +
              (container?.scrollTop ?? 0),
            left:
              rect.left -
              (containerRect?.left ?? 0) +
              (container?.scrollLeft ?? 0),
          },
        };
      }
    } else if (blockSelections.length > 0) {
      const lastBlockSelection = blockSelections[blockSelections.length - 1];
      const block = this.host.view.getBlock(lastBlockSelection.blockId);
      if (block) {
        const rect = block.getBoundingClientRect();
        return {
          blockId: lastBlockSelection.blockId,
          rect: {
            width: 3,
            height: rect.height,
            top:
              rect.top -
              (containerRect?.top ?? 0) +
              (container?.scrollTop ?? 0),
            left:
              rect.left +
              rect.width -
              (containerRect?.left ?? 0) +
              (container?.scrollLeft ?? 0),
          },
        };
      }
    }

    return null;
  }

  private readonly _getSelectionRect = (
    selections: BaseSelection[],
  ): SelectionRect[] => {
    if (!this.block || this.block.model.flavour !== "myoxus:page") {
      return [];
    }

    const textSelection = selections.find(
      (selection) => selection instanceof TextSelection,
    ) as TextSelection | undefined;
    const blockSelections = selections.filter(
      (selection) => selection instanceof BlockSelection,
    );

    if (!textSelection && !blockSelections.length) return [];

    const [_, { selectionRects }] = this.std.command.exec(
      getSelectionRectsCommand,
      {
        textSelection,
        blockSelections,
      },
    );

    if (!selectionRects) return [];

    return selectionRects.map(({ blockId, ...rect }) => {
      if (!blockId) return rect;
      const block = this.host.view.getBlock(blockId);
      if (!block) return rect;
      return {
        ...rect,
        transparent: this._config.blockSelectionBackgroundTransparent(
          block.model,
        ),
      };
    });
  };

  private _measureRecentText(id: string) {
    const block = this.host.view.getBlock(id);
    if (!block || block.model.role !== "content") {
      return { rects: [], fieldRect: null, viewportLeft: 0 };
    }
    const container = this._container;
    const bounds = this._containerRect;
    const offsetTop = (container?.scrollTop ?? 0) - (bounds?.top ?? 0);
    const offsetLeft = (container?.scrollLeft ?? 0) - (bounds?.left ?? 0);
    const rawRects = [...block.querySelectorAll("[data-v-text]")].flatMap(
      (text) => {
        if (text.closest("[data-block-id]") !== block) return [];
        const range = this.host.ownerDocument.createRange();
        range.selectNodeContents(text);
        return [...range.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        );
      },
    );
    const blockRect = block.getBoundingClientRect();
    return {
      rects: rawRects.map((rect) => ({
        top: rect.top + offsetTop,
        left: rect.left + offsetLeft,
        width: rect.width,
        height: rect.height,
      })),
      fieldRect:
        blockRect.height > 0
          ? {
              top: blockRect.top + offsetTop,
              left: blockRect.left + offsetLeft,
              width: blockRect.width,
              height: blockRect.height,
            }
          : null,
      viewportLeft:
        rawRects.length > 0
          ? Math.min(...rawRects.map((r) => r.left))
          : blockRect.left,
    };
  }

  override connectedCallback() {
    super.connectedCallback();
    this._resizeObserver.observe(this.host);

    this._overlay = mountDocRemotePresenceOverlay(this, this.store, {
      getPeers: (): DocRemotePeerSnapshot[] =>
        this._selections.map((selection) => {
          const cursor = this._getCursorInfo(selection.selections);
          return {
            clientId: selection.id,
            userName: selection.user?.name?.trim() ?? "",
            selectionRects: selection.rects,
            caretRect: cursor?.rect ?? null,
            caretBlockId: cursor?.blockId ?? null,
          };
        }),
      measureRecentText: (blockId) => this._measureRecentText(blockId),
    });

    this.handleEvent("wheel", () => {
      this._overlay?.schedulePaint();
    });

    this.disposables.addFromEvent(window, "resize", () => {
      this._overlay?.schedulePaint();
    });

    this.disposables.add(
      effect(() => {
        const selections = this._remoteSelections.value;
        this._updateSelectionsThrottled(selections);
      }),
    );
    this.disposables.add(
      this.std.store.slots.blockUpdated.subscribe(() => {
        this._updateSelectionsThrottled(this._remoteSelections.peek());
      }),
    );
    const gfx = this.std.get(GfxControllerIdentifier);
    this.disposables.add(
      gfx.viewport.viewportUpdated.subscribe(() => {
        const selections = this._remoteSelections.peek();
        this._updateSelections(selections);
      }),
    );
    this.disposables.add(
      this.std.event.active$.subscribe((value) => {
        if (!value) {
          this.std.selection.clearRemote();
        }
      }),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
    this._updateSelectionsThrottled.cancel();
    this._overlay?.dispose();
    this._overlay = null;
  }

  private readonly _updateSelections = (
    selections: typeof this._remoteSelections.value,
  ) => {
    const remoteUsers = new Set<number>();
    this._selections = selections.flatMap(({ selections, id, user }) => {
      if (remoteUsers.has(id)) return [];
      remoteUsers.add(id);
      return {
        id,
        selections,
        rects: this._getSelectionRect(selections),
        user,
      };
    });
    this._overlay?.schedulePaint();
  };

  private readonly _updateSelectionsThrottled = throttle(
    this._updateSelections,
    60,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_DOC_REMOTE_SELECTION_WIDGET]: MyoxusDocRemoteSelectionWidget;
  }
}
