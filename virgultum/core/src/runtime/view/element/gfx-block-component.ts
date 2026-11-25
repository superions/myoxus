import { effect, type Signal } from "@preact/signals-core";
import {
  ErrorCode,
  VirgultumError,
} from "../../../primitives/exceptions/index";
import { Bound } from "../../../primitives/gfx/index";

import type { BlockService } from "../../extension/index.js";
import type { GfxController } from "../../gfx/controller.js";
import type {
  BoxSelectionContext,
  DragMoveContext,
  GfxViewTransformInterface,
} from "../../gfx/interactivity/index.js";
import type { GfxBlockElementModel } from "../../gfx/model/gfx-block-model.js";
import type { BlockComponent } from "./block-component.js";

export function isGfxBlockComponent(
  element: unknown,
): element is GfxBlockComponent {
  return (element as GfxBlockComponent)?.[GfxElementSymbol] === true;
}

export const GfxElementSymbol = Symbol("GfxElement");

function updateTransform(element: GfxBlockComponent) {
  if (element.transformState$.value === "idle") return;

  const { viewport } = element.gfx;
  element.dataset.viewportState = viewport.serializeRecord();
  element.style.transformOrigin = "0 0";
  element.style.transform = element.getCSSTransform();
}

function updateBlockVisibility(view: GfxBlockComponent) {
  if (view.transformState$.value === "active") {
    view.style.visibility = "visible";
    view.style.pointerEvents = "auto";
    view.classList.remove("block-idle");
    view.classList.add("block-active");
  } else {
    view.style.visibility = "hidden";
    view.style.pointerEvents = "none";
    view.classList.remove("block-active");
    view.classList.add("block-idle");
  }
}

export function bindGfxBlockView(instance: GfxBlockComponent) {
  instance.style.position = "absolute";

  instance.disposables.add(
    instance.gfx.viewport.viewportUpdated.subscribe(() => {
      updateTransform(instance);
    }),
  );

  instance.disposables.add(
    instance.store.slots.blockUpdated.subscribe(({ type, id }) => {
      if (id === instance.model.id && type === "update") {
        updateTransform(instance);
      }
    }),
  );

  instance.disposables.add(
    effect(() => {
      updateBlockVisibility(instance);
      updateTransform(instance);
    }),
  );
}

export interface GfxBlockComponent<
  Model extends GfxBlockElementModel = GfxBlockElementModel,
  Service extends BlockService = BlockService,
  WidgetName extends string = string,
>
  extends
    BlockComponent<Model, Service, WidgetName>,
    GfxViewTransformInterface {
  [GfxElementSymbol]: boolean;
  readonly transformState$: Signal<"idle" | "active">;
  readonly gfx: GfxController;
  getCSSTransform(): string;
  getRenderingRect(): {
    x: number;
    y: number;
    w?: number | string;
    h?: number | string;
    zIndex: string;
  };
  toZIndex(): string;
  updateZIndex(): void;
  onBoxSelected(context: BoxSelectionContext): boolean | void;
}

export function gfxBlockTransform(view: GfxBlockComponent) {
  const viewport = view.gfx.viewport;
  const { translateX, translateY, zoom, viewScale } = viewport;
  const bound = Bound.deserialize(view.model.xywh);

  const scaledX = (bound.x * zoom) / viewScale;
  const scaledY = (bound.y * zoom) / viewScale;
  const deltaX = scaledX - bound.x;
  const deltaY = scaledY - bound.y;

  return `translate(${translateX / viewScale + deltaX}px, ${translateY / viewScale + deltaY}px) scale(${zoom / viewScale})`;
}

export function gfxBlockRenderingRect(view: GfxBlockComponent) {
  const { xywh$ } = view.model;

  if (!xywh$) {
    throw new VirgultumError(
      ErrorCode.GfxBlockElementError,
      `Error on rendering '${view.model.flavour}': Gfx block's model should have 'xywh' property.`,
    );
  }

  const [x, y, w, h] = JSON.parse(xywh$.value);

  return { x, y, w, h, zIndex: view.toZIndex() };
}

export function moveGfxBlock(
  model: GfxBlockElementModel,
  context: DragMoveContext,
) {
  model.xywh = context.currentBound
    .moveDelta(context.dx, context.dy)
    .serialize();
}
