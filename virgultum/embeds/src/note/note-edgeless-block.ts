import { signal } from "@preact/signals-core";
import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import type { DocTitle } from "@virgultum/content/title";
import { Bound } from "@virgultum/core/primitives/gfx";
import {
  NOTE_MIN_HEIGHT,
  NoteBlockSchema,
  NoteDisplayMode,
} from "@virgultum/core/models";
import { focusTextModel } from "@virgultum/content/rich-text";
import { EDGELESS_BLOCK_CHILD_PADDING } from "@virgultum/core/consts";
import { TelemetryProvider } from "@virgultum/core/services";
import { handleNativeRangeAtPoint } from "@virgultum/core/utils";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";
import clamp from "lodash-es/clamp";

import { hasEdgelessNoteHeader } from "./config";
import { ACTIVE_NOTE_EXTRA_PADDING } from "./note-edgeless-block.styles";

export const MYOXUS_EDGELESS_NOTE = "myoxus-edgeless-note";

import type { EdgelessNoteBlockComponent } from "./native-edgeless-note-block";
export { EdgelessNoteBlockComponent } from "./native-edgeless-note-block";

export class EdgelessNoteController {
  private readonly _editing = signal(false);
  private readonly _isHover = signal(false);
  private readonly _isResizing = signal(false);
  private readonly _noteFullHeight = signal(0);

  constructor(private readonly view: EdgelessNoteBlockComponent) {}

  get showCollapsedContent() {
    return (
      !!this.view.model.props.edgeless$.value.collapse &&
      this.view.selected$.value &&
      !this._dragging &&
      (this._isResizing.value || this._isHover.value || this._editing.value)
    );
  }

  private get _dragging() {
    return this._isHover.value && this.view.gfx.tool.dragging$.value;
  }

  collapsedStyle() {
    if (!this.showCollapsedContent) {
      return undefined;
    }

    const { xywh, edgeless } = this.view.model.props;
    const { borderSize } = edgeless.style;

    const extraPadding = this._editing.value ? ACTIVE_NOTE_EXTRA_PADDING : 0;
    const extraBorder = this._editing.value ? borderSize : 0;
    const bound = Bound.deserialize(xywh);
    const scale = edgeless.scale ?? 1;
    const width = bound.w / scale + extraPadding * 2 + extraBorder;
    const height = bound.h / scale;

    const rect = this.view.noteContent?.getBoundingClientRect();
    if (!rect) return undefined;

    const zoom = this.view.gfx.viewport.zoom;
    const fullHeight =
      rect.height / scale / zoom + 2 * EDGELESS_BLOCK_CHILD_PADDING;

    if (height >= fullHeight) {
      return undefined;
    }

    return {
      width: `${width}px`,
      height: `${fullHeight - height}px`,
      left: `${-(extraPadding + extraBorder / 2)}px`,
      top: `${height + extraPadding + extraBorder / 2}px`,
    };
  }

  private _handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowUp") {
      this.view.querySelector<DocTitle>("doc-title")?.inlineEditor?.focusEnd();
    }
  }

  readonly hovered = () => {
    if (
      this.view.selection.value.some(
        (sel) => sel.type === "surface" && sel.blockId === this.view.model.id,
      )
    ) {
      if (this._hoverTimeout) {
        clearTimeout(this._hoverTimeout);
        this._hoverTimeout = null;
      }
      this._isHover.value = true;
    }
  };

  private _hoverTimeout: ReturnType<typeof setTimeout> | null = null;

  readonly leaved = (e: MouseEvent) => {
    if (this._hoverTimeout) {
      clearTimeout(this._hoverTimeout);
      this._hoverTimeout = null;
    }
    const rect = this.view.getBoundingClientRect();
    const threshold = -10;
    const leavedFromBottom =
      e.clientY - rect.bottom > threshold &&
      rect.left < e.clientX &&
      e.clientX < rect.right;

    if (leavedFromBottom) {
      this._hoverTimeout = setTimeout(() => {
        this._isHover.value = false;
      }, 300);
    } else {
      this._isHover.value = false;
    }
  };

  readonly setCollapse = (event: MouseEvent) => {
    event.stopImmediatePropagation();

    const { collapse, collapsedHeight } = this.view.model.props.edgeless;

    if (collapse) {
      this.view.model.store.updateBlock(this.view.model, () => {
        this.view.model.props.edgeless.collapse = false;
      });
    } else if (collapsedHeight) {
      const { xywh, edgeless } = this.view.model.props;
      const bound = Bound.deserialize(xywh);
      bound.h = collapsedHeight * (edgeless.scale ?? 1);
      this.view.model.store.updateBlock(this.view.model, () => {
        this.view.model.props.edgeless.collapse = true;
        this.view.model.props.xywh = bound.serialize();
      });
    }

    this.view.selection.clear();
  };

  connect() {
    const selection = this.view.gfx.selection;

    this._editing.value =
      selection.has(this.view.model.id) && selection.editing;
    this.view.disposables.add(
      selection.slots.updated.subscribe(() => {
        if (selection.has(this.view.model.id) && selection.editing) {
          this._editing.value = true;
        } else {
          this._editing.value = false;
        }
      }),
    );

    this.view.disposables.addFromEvent(this.view, "keydown", (event) =>
      this._handleKeyDown(event),
    );
  }

  dispose() {
    if (this._hoverTimeout) {
      clearTimeout(this._hoverTimeout);
      this._hoverTimeout = null;
    }
  }

  get edgelessSlots() {
    return this.view.std.get(EdgelessLegacySlotIdentifier);
  }

  mount() {
    const { disposables } = this.view;
    const selection = this.view.gfx.selection;

    disposables.add(
      this.edgelessSlots.elementResizeStart.subscribe(() => {
        if (selection.selectedElements.includes(this.view.model)) {
          this._isResizing.value = true;
        }
      }),
    );

    disposables.add(
      this.edgelessSlots.elementResizeEnd.subscribe(() => {
        this._isResizing.value = false;
      }),
    );

    const observer = new MutationObserver(() => {
      const rect = this.view.noteContent?.getBoundingClientRect();
      if (!rect) return;
      const zoom = this.view.gfx.viewport.zoom;
      const scale = this.view.model.props.edgeless.scale ?? 1;
      this._noteFullHeight.value =
        rect.height / scale / zoom + 2 * EDGELESS_BLOCK_CHILD_PADDING;
    });
    if (this.view.noteContent) {
      observer.observe(this.view, { childList: true, subtree: true });
      disposables.add(() => observer.disconnect());
    }
  }

  onEditing() {
    this.view.std.getOptional(TelemetryProvider)?.track("EdgelessNoteEditing", {
      page: "edgeless",
      segment: this.view.model.isPageBlock() ? "page" : "note",
    });
  }

  getRenderingRect() {
    const { xywh, edgeless } = this.view.model.props;
    const { collapse, scale = 1 } = edgeless;

    const bound = Bound.deserialize(xywh);
    const width = bound.w / scale;
    const height = bound.h / scale;

    return {
      x: bound.x,
      y: bound.y,
      w: width,
      h: collapse ? height : "unset",
      zIndex: this.view.toZIndex(),
    };
  }

  read() {
    const { model } = this.view;
    const { displayMode } = model.props;
    if (!!displayMode && displayMode === NoteDisplayMode.DocOnly) return null;

    const { xywh, edgeless } = model.props;
    const { borderRadius } = edgeless.style;
    const { collapse = false, collapsedHeight, scale = 1 } = edgeless;

    const { tool } = this.view.gfx;

    const bound = Bound.deserialize(xywh);
    const height = bound.h / scale;

    const style = {
      borderRadius: borderRadius + "px",
      // Match creation and resize constraints before measuring persisted bounds.
      minHeight: `${NOTE_MIN_HEIGHT}px`,
      transform: `scale(${scale})`,
    };

    const extra = this._editing.value ? ACTIVE_NOTE_EXTRA_PADDING : 0;

    const isCollapsable =
      collapse != null &&
      collapsedHeight != null &&
      collapsedHeight !== this._noteFullHeight.value;

    const isCollapseArrowUp = collapse
      ? this._noteFullHeight.value < height
      : !!collapsedHeight && collapsedHeight < height;

    const hasHeader = hasEdgelessNoteHeader({
      note: model,
      std: this.view.std,
    });

    return {
      style,
      modelHeight: bound.h,
      editing: this._editing.value,
      collapse,
      scale,
      fitsPageTables: !collapse && displayMode !== NoteDisplayMode.EdgelessOnly,
      canToggleCollapse:
        isCollapsable &&
        tool.currentToolName$.value !== "frameNavigator" &&
        !hasHeader,
      collapseArrowUp: isCollapseArrowUp,
      collapseButtonBottom: this._editing.value ? `${-extra}px` : "0",
      overflowY: this.showCollapsedContent ? "initial" : "clip",
      collapsedStyle: this.collapsedStyle(),
    };
  }
}

export const EdgelessNoteInteraction =
  GfxViewInteractionExtension<EdgelessNoteBlockComponent>(
    NoteBlockSchema.model.flavour,
    {
      resizeConstraint: {
        minWidth: 170 + 24 * 2,
        minHeight: NOTE_MIN_HEIGHT,
      },
      handleRotate: () => {
        return {
          beforeRotate(context) {
            context.set({
              rotatable: false,
            });
          },
        };
      },
      handleResize: ({ model }) => {
        const initialScale: number = model.props.edgeless.scale ?? 1;
        return {
          onResizeStart(context): void {
            context.default(context);
            model.stash("edgeless");
          },

          onResizeMove(context): void {
            const { originalBound, newBound, lockRatio, constraint } = context;
            const { minWidth, minHeight, maxHeight, maxWidth } = constraint;

            let scale = initialScale;
            let edgelessProp = { ...model.props.edgeless };
            const originalRealWidth = originalBound.w / scale;

            if (lockRatio) {
              scale = newBound.w / originalRealWidth;
              edgelessProp.scale = scale;
            }

            newBound.w = clamp(newBound.w, minWidth * scale, maxWidth);
            newBound.h = clamp(newBound.h, minHeight * scale, maxHeight);

            if (newBound.h > minHeight * scale) {
              edgelessProp.collapse = true;
              edgelessProp.collapsedHeight = newBound.h / scale;
            }

            model.props.edgeless = edgelessProp;
            model.props.xywh = newBound.serialize();
          },

          onResizeEnd(context): void {
            context.default(context);
            model.pop("edgeless");
          },
        };
      },
      handleSelection: ({ std, gfx, view, model }) => {
        return {
          selectable(context) {
            return context.default(context);
          },
          onSelect(context) {
            const { selected, multiSelect, event: e } = context;
            const { editing } = gfx.selection;
            const alreadySelected = gfx.selection.has(model.id);

            if (!multiSelect && selected && (alreadySelected || editing)) {
              if (model.isLocked()) return;

              if (alreadySelected && editing) {
                return;
              }

              gfx.selection.set({
                elements: [model.id],
                editing: true,
              });

              view.updateComplete
                .then(() => {
                  if (!view.isConnected) {
                    return;
                  }

                  let isClickOnTitle = false;
                  const titleRect = view
                    .querySelector("edgeless-page-block-title")
                    ?.getBoundingClientRect();

                  if (titleRect) {
                    const titleBound = new Bound(
                      titleRect.x,
                      titleRect.y,
                      titleRect.width,
                      titleRect.height,
                    );
                    if (titleBound.isPointInBound([e.clientX, e.clientY])) {
                      isClickOnTitle = true;
                    }
                  }

                  if (isClickOnTitle) {
                    handleNativeRangeAtPoint(e.clientX, e.clientY);
                    return;
                  }

                  if (model.children.length === 0) {
                    const blockId = std.store.addBlock(
                      "myoxus:paragraph",
                      { type: "text" },
                      model.id,
                    );

                    if (blockId) {
                      focusTextModel(std, blockId);
                    }
                  } else {
                    const rect = view
                      .querySelector(".myoxus-block-children-container")
                      ?.getBoundingClientRect();

                    if (rect) {
                      const offsetY = 8 * gfx.viewport.zoom;
                      const offsetX = 2 * gfx.viewport.zoom;
                      const x = clamp(
                        e.clientX,
                        rect.left + offsetX,
                        rect.right - offsetX,
                      );
                      const y = clamp(
                        e.clientY,
                        rect.top + offsetY,
                        rect.bottom - offsetY,
                      );
                      handleNativeRangeAtPoint(x, y);
                    } else {
                      handleNativeRangeAtPoint(e.clientX, e.clientY);
                    }
                  }
                })
                .catch(console.error);
            } else {
              context.default(context);
            }
          },
        };
      },
    },
  );
