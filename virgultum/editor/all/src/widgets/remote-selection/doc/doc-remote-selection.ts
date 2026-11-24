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
import { type BaseSelection, Text, type UserInfo } from "@virgultum/core/store";
import throttle from "lodash-es/throttle";

import { RemoteColorManager } from "../manager/remote-color-manager";
import { textMarkerColor } from "../manager/color-picker";
import type { DocRemoteSelectionConfig } from "./config";
import { cursorStyle, selectionStyle } from "./utils";

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
  // avoid being unable to select text by mouse click or drag
  private static readonly styles = `
    :host {
      pointer-events: none;
    }

    .recent-remote-text {
      position: absolute;
      pointer-events: none;
      animation: recent-remote-text 15s ease-out forwards;
    }

    .remote-username {
      position: absolute;
      left: 0;
      bottom: 100%;
      background-color: var(--myoxus-background-primary-color);
      color: var(--myoxus-text-primary-color);
      max-width: 160px;
      font-size: var(--myoxus-font-xs);
      line-height: 18px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @keyframes recent-remote-text {
      0% {
        opacity: 0.3;
      }
      100% {
        opacity: 0;
      }
    }
  `;

  private readonly marks = this.ownerDocument.createElement("div");
  private readonly selections = this.ownerDocument.createElement("div");
  private paintPending = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = MyoxusDocRemoteSelectionWidget.styles;
    shadow.append(style, this.marks, this.selections);
  }

  private schedulePaint() {
    if (this.paintPending || !this.isConnected) return;
    this.paintPending = true;
    queueMicrotask(() => {
      this.paintPending = false;
      if (this.isConnected) this.paint();
    });
  }

  private _selections: Array<{
    id: number;
    selections: BaseSelection[];
    rects: SelectionRect[];
    user?: UserInfo;
  }> = [];

  private _remoteColorManager: RemoteColorManager | null = null;

  // View-only marks never enter Yjs or undo history. Awareness identifies the
  // editor explicitly, including deletions; cursor positions are not authorship.
  private readonly _recentChanges = new Map<
    string,
    {
      timeout: ReturnType<typeof setTimeout>;
      color: string;
      anchor: HTMLDivElement;
    }
  >();

  private readonly _seenTextChanges = new Map<number, number>();
  private readonly _pendingLocalChanges = new Set<string>();

  private _clearRecentChange(id: string) {
    const change = this._recentChanges.get(id);
    if (!change) return;
    clearTimeout(change.timeout);
    change.anchor.remove();
    this._recentChanges.delete(id);
  }

  private _markRecentChange(id: string, color: string) {
    this._clearRecentChange(id);
    const anchor = this.ownerDocument.createElement("div");
    anchor.dataset.remoteChangeBlock = id;
    this.marks.append(anchor);
    this._recentChanges.set(id, {
      anchor,
      timeout: setTimeout(() => this._clearRecentChange(id), 15000),
      color,
    });
    this.schedulePaint();
  }

  private _announceTextChange(id: string) {
    // Collect the text blocks of one edit/paste before publishing its cue.
    if (this._pendingLocalChanges.size === 0) {
      queueMicrotask(() => {
        if (!this.isConnected || this._pendingLocalChanges.size === 0) return;
        const awareness = this.store.awarenessStore;
        const sequence =
          (awareness.getLocalState().recentTextChanges?.sequence ?? 0) + 1;
        const blocks = [...this._pendingLocalChanges];
        this._pendingLocalChanges.clear();
        awareness.setLocalStateField("recentTextChanges", { sequence, blocks });
      });
    }
    this._pendingLocalChanges.add(id);
  }

  private readonly _receiveTextChanges = () => {
    const awareness = this.store.awarenessStore;
    const states = awareness.getStates();
    for (const client of this._seenTextChanges.keys()) {
      if (!states.has(client)) this._seenTextChanges.delete(client);
    }
    for (const [client, state] of states) {
      if (client === awareness.awareness.clientID) continue;
      const change = state.recentTextChanges;
      const previous = this._seenTextChanges.get(client);
      const sequence = change?.sequence ?? 0;
      if (!Number.isSafeInteger(sequence)) continue;
      this._seenTextChanges.set(client, sequence);
      // Initial awareness snapshots describe existing state, not a fresh edit.
      if (previous === undefined || previous === sequence) continue;
      const color = this._remoteColorManager?.get(client);
      if (!color || !Array.isArray(change?.blocks)) continue;
      for (const id of change.blocks) {
        if (typeof id === "string")
          this._markRecentChange(id, textMarkerColor(color));
      }
    }
  };

  private readonly _remoteSelections = computed(() => {
    const status = this.store.awarenessStore.getStates();
    return [...this.std.selection.remoteSelections.entries()].map(
      ([id, selections]) => {
        return {
          id,
          selections,
          user: status.get(id)?.user,
        };
      },
    );
  });

  private readonly _resizeObserver: ResizeObserver = new ResizeObserver(() => {
    this.schedulePaint();
  });

  private get _config(): DocRemoteSelectionConfig {
    return {
      blockSelectionBackgroundTransparent: (block) => {
        return matchModels(block, [
          CodeBlockModel,
          DatabaseBlockModel,
          ImageBlockModel,
          AttachmentBlockModel,
          BookmarkBlockModel,
          SurfaceRefBlockModel,
          ...EMBED_BLOCK_MODEL_LIST,
        ]);
      },
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
      // If no range, maybe the block is not updated yet
      // We just set the range to the end of the block
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

  private _getCursorRect(selections: BaseSelection[]): SelectionRect | null {
    if (!this.block) {
      return null;
    }

    if (this.block.model.flavour !== "myoxus:page") {
      console.error("remote selection widget must be used in page component");
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

      const container = this._container;
      const containerRect = this._containerRect;
      const rangeRects = Array.from(range.getClientRects());
      if (rangeRects.length > 0) {
        const rect =
          rangeRects.length === 1
            ? rangeRects[0]
            : rangeRects[rangeRects.length - 1];
        return {
          width: 3,
          height: rect.height,
          top:
            rect.top - (containerRect?.top ?? 0) + (container?.scrollTop ?? 0),
          left:
            rect.left -
            (containerRect?.left ?? 0) +
            (container?.scrollLeft ?? 0),
        };
      }
    } else if (blockSelections.length > 0) {
      const lastBlockSelection = blockSelections[blockSelections.length - 1];

      const block = this.host.view.getBlock(lastBlockSelection.blockId);
      if (block) {
        const rect = block.getBoundingClientRect();

        return {
          width: 2,
          height: rect.height,
          top:
            rect.top - (containerRect?.top ?? 0) + (container?.scrollTop ?? 0),
          left:
            rect.left +
            rect.width -
            (containerRect?.left ?? 0) +
            (container?.scrollLeft ?? 0),
        };
      }
    }

    return null;
  }

  private readonly _getSelectionRect = (
    selections: BaseSelection[],
  ): SelectionRect[] => {
    if (!this.block) {
      return [];
    }

    if (this.block.model.flavour !== "myoxus:page") {
      console.error("remote selection widget must be used in page component");
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

      const isTransparent = this._config.blockSelectionBackgroundTransparent(
        block.model,
      );

      return {
        ...rect,
        transparent: isTransparent,
      };
    });
  };

  override connectedCallback() {
    super.connectedCallback();
    this._resizeObserver.observe(this.host);

    this.handleEvent("wheel", () => {
      this.schedulePaint();
    });

    this.disposables.addFromEvent(window, "resize", () => {
      this.schedulePaint();
    });

    this._remoteColorManager = new RemoteColorManager(
      this.store.awarenessStore,
    );
    const awareness = this.store.awarenessStore.awareness;
    this._receiveTextChanges();
    awareness.on("change", this._receiveTextChanges);
    this.disposables.add(() =>
      awareness.off("change", this._receiveTextChanges),
    );

    this.disposables.add(
      effect(() => {
        const selections = this._remoteSelections.value;
        this._updateSelectionsThrottled(selections);
      }),
    );
    this.disposables.add(
      this.std.store.slots.blockUpdated.subscribe((event) => {
        if (event.type === "delete") {
          this._clearRecentChange(event.id);
        } else if (event.isLocal) {
          const model = this.store.getBlock(event.id)?.model;
          const textChanged =
            event.type === "add"
              ? !event.init &&
                Object.values(event.model.props).some(
                  (value) => value instanceof Text,
                )
              : model &&
                Reflect.get(model.props, event.props.key) instanceof Text;
          // Root titles are document metadata, not rendered text blocks.
          if (model?.role === "content" && textChanged) {
            this._announceTextChange(event.id);
          }
        }
        this._updateSelectionsThrottled(this._remoteSelections.peek());
        this.schedulePaint();
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
    this.marks.replaceChildren();
    this.selections.replaceChildren();
    this._updateSelectionsThrottled.cancel();
    for (const entry of this._recentChanges.values())
      clearTimeout(entry.timeout);
    this._recentChanges.clear();
    this._pendingLocalChanges.clear();
    this._seenTextChanges.clear();
  }

  private readonly _updateSelections = (
    selections: typeof this._remoteSelections.value,
  ) => {
    const remoteUsers = new Set<number>();
    this._selections = selections.flatMap(({ selections, id, user }) => {
      if (remoteUsers.has(id)) {
        return [];
      } else {
        remoteUsers.add(id);
      }

      return {
        id,
        selections,
        rects: this._getSelectionRect(selections),
        user,
      };
    });
    this.schedulePaint();
  };

  private readonly _updateSelectionsThrottled = throttle(
    this._updateSelections,
    60,
  );

  private _getRecentTextRects(id: string): DOMRect[] {
    const block = this.host.view.getBlock(id);
    if (!block || block.model.role !== "content") return [];
    // Paint text fragments, including wrapped lines, rather than framing the
    // whole block or its children. Reading ranges never changes selection.
    return [...block.querySelectorAll("[data-v-text]")].flatMap((text) => {
      if (text.closest("[data-block-id]") !== block) return [];
      const range = this.host.ownerDocument.createRange();
      range.selectNodeContents(text);
      return [...range.getClientRects()].filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
    });
  }

  private paint() {
    const doc = this.ownerDocument;
    const colors = this._remoteColorManager;
    if (!colors) return;
    // A mark owns its animated fragments for the lifetime of one edit cue.
    // Updating another cursor must not restart the fifteen-second fade.
    if (this._recentChanges.size) {
      const container = this._container;
      const bounds = this._containerRect;
      for (const [id, { anchor, color }] of this._recentChanges) {
        const rects = this._getRecentTextRects(id);
        while (anchor.childElementCount > rects.length)
          anchor.lastElementChild!.remove();
        rects.forEach((rect, i) => {
          const mark =
            (anchor.children[i] as HTMLElement | undefined) ??
            doc.createElement("div");
          if (!mark.parentElement) {
            mark.className = "recent-remote-text";
            anchor.append(mark);
          }
          Object.assign(mark.style, {
            backgroundColor: color,
            top: `${rect.top - (bounds?.top ?? 0) + (container?.scrollTop ?? 0)}px`,
            left: `${rect.left - (bounds?.left ?? 0) + (container?.scrollLeft ?? 0)}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          });
        });
      }
    }
    const fragment = doc.createDocumentFragment();
    for (const selection of this._selections) {
      const color = colors.get(selection.id);
      if (!color) continue;
      for (const rect of selection.rects) {
        const node = doc.createElement("div");
        Object.assign(node.style, selectionStyle(rect, color));
        fragment.append(node);
      }
      const rect = this._getCursorRect(selection.selections);
      if (!rect) continue;
      const cursor = doc.createElement("div");
      Object.assign(cursor.style, cursorStyle(rect, color));
      if (selection.user) {
        const label = doc.createElement("div");
        label.className = "remote-username";
        label.textContent = selection.user.name;
        cursor.append(label);
      }
      fragment.append(cursor);
    }
    this.selections.replaceChildren(fragment);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_DOC_REMOTE_SELECTION_WIDGET]: MyoxusDocRemoteSelectionWidget;
  }
}
