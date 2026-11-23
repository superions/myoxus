import { computed } from "@preact/signals-core";
import { TextUtils } from "@virgultum/canvas-runtime/surface";
import { almostEqual, Bound, clamp } from "@virgultum/core/primitives/gfx";
import { formatBlockCommand } from "@virgultum/content/inlines";
import {
  DefaultTheme,
  EDGELESS_TEXT_BLOCK_MIN_HEIGHT,
  EDGELESS_TEXT_BLOCK_MIN_WIDTH,
  EdgelessTextBlockSchema,
  ListBlockModel,
  ParagraphBlockModel,
} from "@virgultum/core/models";
import { focusTextModel } from "@virgultum/content/rich-text";
import { ThemeProvider } from "@virgultum/core/services";
import { handleNativeRangeAtPoint, matchModels } from "@virgultum/core/utils";
import {
  type BlockComponent,
  BlockSelection,
  TextSelection,
} from "@virgultum/core/runtime";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";

import type { EdgelessTextBlockComponent } from "./native-edgeless-text-block";

export { EdgelessTextBlockComponent } from "./native-edgeless-text-block";

export const edgelessTextCss = `
  .edgeless-text-block-container[data-max-width="false"] .inline-editor span {
    word-break: keep-all !important;
    text-wrap: nowrap !important;
  }

  .edgeless-text-block-container myoxus-paragraph,
  myoxus-list {
    color: var(--edgeless-text-color);
    font-family: var(--edgeless-text-font-family);
    font-style: var(--edgeless-text-font-style);
    font-weight: var(--edgeless-text-font-weight);
    text-align: var(--edgeless-text-text-align);
  }
`;

export class EdgelessTextController {
  constructor(private readonly view: EdgelessTextBlockComponent) {}

  private _measureFrame = 0;
  private readonly _resizeObserver = new ResizeObserver(() => {
    if (!this._measureFrame)
      this._measureFrame = requestAnimationFrame(this._measure);
  });

  private readonly _measure = () => {
    this._measureFrame = 0;
    const { model, store, gfx, textContainer } = this.view;
    if (!this.view.isConnected || store.readonly) return;

    const { zoom } = gfx.viewport;
    const bound = Bound.deserialize(model.xywh);
    const rect = textContainer.getBoundingClientRect();
    const width = model.props.hasMaxWidth
      ? bound.w
      : Math.max(rect.width / zoom, EDGELESS_TEXT_BLOCK_MIN_WIDTH * zoom);
    const height = rect.height / zoom;
    if (almostEqual(width, bound.w) && almostEqual(height, bound.h)) return;

    // The view reacts synchronously to geometry changes. Write one size after
    // observer delivery so updating the measured element does not reenter it.
    bound.w = width;
    bound.h = height;
    store.updateBlock(model, { xywh: bound.serialize() });
  };

  private readonly _style$ = computed(() => {
    const {
      color$: { value: color },
      fontFamily$: { value: fontFamily },
      fontStyle$: { value: fontStyle },
      fontWeight$: { value: fontWeight },
      textAlign$: { value: textAlign },
    } = this.view.model.props;
    return {
      color,
      fontFamily,
      fontStyle,
      fontWeight,
      textAlign,
    };
  });

  checkWidthOverflow(width: number) {
    let wValid = true;

    const oldWidthStr = this.view.textContainer.style.width;
    this.view.textContainer.style.width = `${width}px`;
    if (
      this.view.childrenContainer.scrollWidth >
      this.view.childrenContainer.offsetWidth
    ) {
      wValid = false;
    }
    this.view.textContainer.style.width = oldWidthStr;

    return wValid;
  }

  connect() {
    this.view.disposables.add(
      this.view.model.propsUpdated.subscribe(({ key }) => {
        this.view.updateComplete
          .then(() => {
            if (!this.view.isConnected || this.view.store.readonly) return;
            const command = this.view.std.command;
            const blockSelections = this.view.model.children.map((child) =>
              this.view.std.selection.create(BlockSelection, {
                blockId: child.id,
              }),
            );

            if (key === "fontStyle") {
              command.exec(formatBlockCommand, {
                blockSelections,
                styles: {
                  italic: null,
                },
              });
            } else if (key === "color") {
              command.exec(formatBlockCommand, {
                blockSelections,
                styles: {
                  color: null,
                },
              });
            } else if (key === "fontWeight") {
              command.exec(formatBlockCommand, {
                blockSelections,
                styles: {
                  bold: null,
                },
              });
            }
          })
          .catch(console.error);
      }),
    );
  }

  mount() {
    const { disposables, std } = this.view;
    const edgelessSelection = this.view.gfx.selection;

    disposables.add(
      edgelessSelection.slots.updated.subscribe(() => {
        if (
          edgelessSelection.has(this.view.model.id) &&
          edgelessSelection.editing
        ) {
          this.view.editing.value = true;
        } else {
          this.view.editing.value = false;
        }
      }),
    );

    this._resizeObserver.observe(this.view.textContainer);
    disposables.add(() => {
      this._resizeObserver.disconnect();
      cancelAnimationFrame(this._measureFrame);
      this._measureFrame = 0;
    });

    disposables.addFromEvent(this.view.textContainer, "click", (e) => {
      if (!this.view.editing.value) return;

      const containerRect = this.view.textContainer.getBoundingClientRect();
      const isTop = e.clientY < containerRect.top + containerRect.height / 2;

      let newParagraphId: string | null = null;
      if (isTop) {
        const firstChild = this.view.model.firstChild();
        if (
          !firstChild ||
          !matchModels(firstChild, [ListBlockModel, ParagraphBlockModel])
        ) {
          newParagraphId = this.view.store.addBlock(
            "myoxus:paragraph",
            {},
            this.view.model.id,
            0,
          );
        }
      } else {
        const lastChild = this.view.model.lastChild();
        if (
          !lastChild ||
          !matchModels(lastChild, [ListBlockModel, ParagraphBlockModel])
        ) {
          newParagraphId = this.view.store.addBlock(
            "myoxus:paragraph",
            {},
            this.view.model.id,
          );
        }
      }

      if (newParagraphId) {
        std.selection.setGroup("note", [
          std.selection.create(TextSelection, {
            from: {
              blockId: newParagraphId,
              index: 0,
              length: 0,
            },
            to: null,
          }),
        ]);
      }
    });

    disposables.addFromEvent(this.view.textContainer, "focusout", () => {
      if (!this.view.editing.value) return;

      this.view.std.selection.clear();
    });

    let composingWidth = EDGELESS_TEXT_BLOCK_MIN_WIDTH;
    disposables.addFromEvent(this.view, "compositionupdate", () => {
      composingWidth = Math.max(
        this.view.textContainer.offsetWidth,
        EDGELESS_TEXT_BLOCK_MIN_HEIGHT,
      );
    });
    disposables.addFromEvent(this.view, "compositionend", () => {
      if (this.view.model.props.hasMaxWidth) {
        composingWidth = EDGELESS_TEXT_BLOCK_MIN_WIDTH;
        return;
      }
      // when IME finish container will crash to a small width, so
      // we set a max width to prevent this
      this.view.textContainer.style.width = `${composingWidth}px`;
      this.view.model.props.hasMaxWidth = true;
      requestAnimationFrame(() => {
        this.view.textContainer.style.width = "";
      });
    });
  }

  getCSSTransform(): string {
    const viewport = this.view.gfx.viewport;
    const { translateX, translateY, zoom } = viewport;
    const bound = Bound.deserialize(this.view.model.xywh);

    const scaledX = bound.x * zoom;
    const scaledY = bound.y * zoom;
    const deltaX = scaledX - bound.x;
    const deltaY = scaledY - bound.y;

    return `translate(${translateX + deltaX}px, ${translateY + deltaY}px) scale(${zoom * this.view.model.props.scale})`;
  }

  getRenderingRect() {
    const { xywh, scale, rotate, hasMaxWidth } = this.view.model.props;
    const bound = Bound.deserialize(xywh);
    const w = hasMaxWidth ? bound.w / scale : undefined;

    return {
      x: bound.x,
      y: bound.y,
      w,
      h: bound.h / scale,
      rotate,
      zIndex: this.view.toZIndex(),
    };
  }

  getLayoutStyle() {
    const { model } = this.view;
    const { rotate, hasMaxWidth } = model.props;
    const editing = this.view.editing.value;
    const containerStyle = {
      transform: `rotate(${rotate}deg)`,
      transformOrigin: "center",
      border: `1px solid ${editing ? "var(--affine—primary—color, #1e96eb)" : "transparent"}`,
      borderRadius: "4px",
      boxSizing: "border-box",
      boxShadow: editing ? "0px 0px 0px 2px rgba(30, 150, 235, 0.3)" : "none",
      fontWeight: "400",
      lineHeight: "var(--myoxus-line-height)",
      minWidth: !hasMaxWidth ? "220px" : "",
    };

    return containerStyle;
  }

  getTextStyle() {
    const { color, fontFamily, fontStyle, fontWeight, textAlign } =
      this._style$.value;
    const themeProvider = this.view.std.get(ThemeProvider);
    const textColor = themeProvider.generateColorProperty(
      color,
      DefaultTheme.textColor,
      themeProvider.theme$.value,
    );

    return {
      "--edgeless-text-color": textColor,
      "--edgeless-text-font-family": TextUtils.wrapFontFamily(fontFamily),
      "--edgeless-text-font-style": fontStyle,
      "--edgeless-text-font-weight": fontWeight,
      "--edgeless-text-text-align": textAlign,
      "--myoxus-list-margin": "0",
      "--myoxus-paragraph-margin": "0",
    };
  }

  tryFocusEnd() {
    const paragraphOrLists = Array.from(
      this.view.querySelectorAll<BlockComponent>(
        "myoxus-paragraph, myoxus-list",
      ),
    );
    const last = paragraphOrLists.at(-1);
    if (last) {
      this.view.host.selection.setGroup("note", [
        this.view.host.selection.create(TextSelection, {
          from: {
            blockId: last.blockId,
            index: last.model.text?.length ?? 0,
            length: 0,
          },
          to: null,
        }),
      ]);
    }
  }
}

export const EdgelessTextInteraction =
  GfxViewInteractionExtension<EdgelessTextBlockComponent>(
    EdgelessTextBlockSchema.model.flavour,
    {
      resizeConstraint: {
        lockRatio: ["top-left", "top-right", "bottom-left", "bottom-right"],
        allowedHandlers: [
          "top-left",
          "top-right",
          "left",
          "right",
          "bottom-left",
          "bottom-right",
        ],
        minWidth: EDGELESS_TEXT_BLOCK_MIN_WIDTH,
      },
      handleResize: (context) => {
        const { model, view } = context;
        const initialScale = model.props.scale;

        return {
          onResizeStart(context) {
            context.default(context);
            model.stash("scale");
            model.stash("hasMaxWidth");
          },
          onResizeMove(context) {
            const { originalBound, newBound, constraint, lockRatio } = context;

            if (lockRatio) {
              const originalRealWidth = originalBound.w / initialScale;
              const newScale = newBound.w / originalRealWidth;

              model.props.scale = newScale;
              model.props.xywh = newBound.serialize();
            } else {
              if (!view.checkWidthOverflow(newBound.w)) {
                return;
              }

              const newRealWidth = clamp(
                newBound.w / initialScale,
                constraint.minWidth,
                constraint.maxWidth,
              );

              const curBound = Bound.deserialize(model.xywh);

              model.props.xywh = Bound.serialize({
                ...newBound,
                w: newRealWidth * initialScale,
                h: curBound.h,
              });
              model.props.hasMaxWidth = true;
            }
          },
          onResizeEnd(context) {
            context.default(context);
            model.pop("scale");
            model.pop("hasMaxWidth");
          },
        };
      },

      handleSelection: (context) => {
        const { gfx, std, view, model } = context;
        return {
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
              return context.default(context);
            }
          },
        };
      },
    },
  );
