import { computed, effect } from "@preact/signals-core";
import {
  AttachmentBlockModel,
  BookmarkBlockModel,
  CodeBlockModel,
  DatabaseBlockModel,
  ImageBlockModel,
  SurfaceRefBlockModel,
} from "@virgultum/model";
import { getSelectionRectsCommand } from "@virgultum/shared/commands";
import { EMBED_BLOCK_MODEL_LIST } from "@virgultum/shared/consts";
import { matchModels } from "@virgultum/shared/utils";
import { BlockSelection, TextSelection, WidgetComponent } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { type BaseSelection, Text, type UserInfo } from "@virgultum/store";
import { css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { styleMap } from "lit/directives/style-map.js";
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

export class MyoxusDocRemoteSelectionWidget extends WidgetComponent {
  // avoid being unable to select text by mouse click or drag
  static override styles = css`
    :host {
      pointer-events: none;
    }

    .recent-remote-text {
      position: absolute;
      pointer-events: none;
      animation: recent-remote-text 15s ease-out forwards;
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

  @state()
  private accessor _selections: Array<{
    id: number;
    selections: BaseSelection[];
    rects: SelectionRect[];
    user?: UserInfo;
  }> = [];

  private readonly _abortController = new AbortController();

  private _remoteColorManager: RemoteColorManager | null = null;

  // View-only marks never enter Yjs or undo history. Awareness identifies the
  // editor explicitly, including deletions; cursor positions are not authorship.
  private readonly _recentChanges = new Map<
    string,
    { timeout: ReturnType<typeof setTimeout>; color: string }
  >();

  private readonly _seenTextChanges = new Map<number, number>();
  private readonly _pendingLocalChanges = new Set<string>();

  private _clearRecentChange(id: string) {
    clearTimeout(this._recentChanges.get(id)?.timeout);
    if (this._recentChanges.delete(id)) this.requestUpdate();
  }

  private _markRecentChange(id: string, color: string) {
    this._clearRecentChange(id);
    this._recentChanges.set(id, {
      timeout: setTimeout(() => this._clearRecentChange(id), 15000),
      color,
    });
    this.requestUpdate();
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
    this.requestUpdate();
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
      this.requestUpdate();
    });

    this.disposables.addFromEvent(window, "resize", () => {
      this.requestUpdate();
    });

    this._remoteColorManager = new RemoteColorManager(this.std);
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
        this.requestUpdate();
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
    this._abortController.abort();
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

  override render() {
    if (this._selections.length === 0 && this._recentChanges.size === 0) {
      return nothing;
    }

    const remoteColorManager = this._remoteColorManager;
    if (!remoteColorManager) return nothing;
    return html`<div>
      ${[...this._recentChanges].map(([id, { timeout, color }]) => {
        const rects = this._getRecentTextRects(id);
        const containerRect = this._containerRect;
        const container = this._container;
        return keyed(
          timeout,
          html`<div data-remote-change-block=${id}>
            ${rects.map(
              (rect) =>
                html`<div
                  class="recent-remote-text"
                  style=${styleMap({
                    backgroundColor: color,
                    top: `${rect.top - (containerRect?.top ?? 0) + (container?.scrollTop ?? 0)}px`,
                    left: `${rect.left - (containerRect?.left ?? 0) + (container?.scrollLeft ?? 0)}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                  })}
                ></div>`,
            )}
          </div>`,
        );
      })}
      ${this._selections.map((selection) => {
        const color = remoteColorManager.get(selection.id);
        if (!color) return [];
        const cursorRect = this._getCursorRect(selection.selections);

        return selection.rects
          .map((r) => html`<div style="${selectionStyle(r, color)}"></div>`)
          .concat([
            html`
              <div
                style="${
                  cursorRect
                    ? cursorStyle(cursorRect, color)
                    : styleMap({
                        display: "none",
                      })
                }"
              >
                <div
                  style="${styleMap({
                    position: "relative",
                    height: "100%",
                  })}"
                >
                  <div
                    style="${styleMap({
                      position: "absolute",
                      left: "0",
                      bottom: "100%",
                      backgroundColor: "var(--myoxus-background-primary-color)",
                      color: "var(--myoxus-text-primary-color)",
                      maxWidth: "160px",
                      fontSize: "var(--myoxus-font-xs)",
                      lineHeight: "18px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      display: selection.user ? "block" : "none",
                    })}"
                  >
                    ${selection.user?.name}
                  </div>
                </div>
              </div>
            `,
          ]);
      })}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_DOC_REMOTE_SELECTION_WIDGET]: MyoxusDocRemoteSelectionWidget;
  }
}
