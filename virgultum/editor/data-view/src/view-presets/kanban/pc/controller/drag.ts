import { computed } from "@preact/signals-core";
import { Point, Rect } from "@virgultum/global/gfx";
import type { InsertToPosition } from "@virgultum/shared/utils";
import type { ReactiveController } from "lit";

import { autoScrollOnBoundary } from "../../../../core/utils/auto-scroll.js";
import { startDrag } from "../../../../core/utils/drag.js";
import {
  cardMidpointsInCanvas,
  dropIndicatorRectInCanvas,
} from "../../kanban-selection-edgeless-adapter.js";
import { PAGE_VIEWPORT, type ViewportContext } from "../../viewport-context.js";
import { KanbanCard } from "../card.js";
import { KanbanGroup } from "../group.js";
import type { KanbanViewUILogic } from "../kanban-view-ui-logic.js";

export class KanbanDragController implements ReactiveController {
  dragStart = (ele: KanbanCard, evt: PointerEvent) => {
    const host = this.host;
    if (!host) {
      return;
    }
    // P-VIRG-ARCH-E-02: Im Edgeless-Modus ist `eleRect` um
    // `viewport.scale` vergroessert. Das Drag-Preview-Element sitzt
    // aber ausserhalb des Canvas (document.body-Child) und arbeitet
    // in CSS-Pixeln. Wir muessen daher die Maus-Offsets in CSS-Pixel
    // lassen, das Preview-Position ebenfalls. Skalierung wirkt
    // hier nur symmetrisch (Preview UND Karte beide CSS-Pixel),
    // daher kein Divide noetig.
    //
    // E-02-FIX-08: Asymmetrische Faelle (Pointer in Canvas-Pixel
    // vs. Preview in CSS-Pixel) sind in Edgeless nicht erreichbar,
    // weil der Pointer vom `getBoundingClientRect`-CSS-Pixel-
    // System kommt und das Preview ein body-Element ist.
    const eleRect = ele.getBoundingClientRect();
    const offsetLeft = evt.x - eleRect.left;
    const offsetTop = evt.y - eleRect.top;
    const preview = createDragPreview(
      ele,
      evt.x - offsetLeft,
      evt.y - offsetTop,
    );
    const currentGroup = ele.closest("myoxus-data-view-kanban-group");
    const drag = startDrag<
      | { type: "out"; callback: () => void }
      | {
          type: "self";
          key: string;
          position: InsertToPosition;
        }
      | undefined,
      PointerEvent
    >(evt, {
      onDrag: () => undefined,
      onMove: (evt) => {
        if (!(evt.target instanceof HTMLElement)) {
          return;
        }
        preview.display(evt.x - offsetLeft, evt.y - offsetTop);
        if (!Rect.fromDOM(host).isPointIn(Point.from(evt))) {
          const callback = this.logic.root.config.onDrag;
          if (callback) {
            this.dropPreview.remove();
            return {
              type: "out",
              callback: callback(evt, ele.cardId),
            };
          }
          return;
        }
        const result = this.showIndicator(evt, ele);
        if (result) {
          return {
            type: "self",
            key: result.group.group.key,
            position: result.position,
          };
        }
        return;
      },
      onClear: () => {
        preview.remove();
        this.dropPreview.remove();
        cancelScroll();
      },
      onDrop: (result) => {
        if (!result) {
          return;
        }
        if (result.type === "out") {
          result.callback();
          return;
        }
        if (result && currentGroup) {
          currentGroup.group.manager.moveCardTo(
            ele.cardId,
            currentGroup.group.key,
            result.key,
            result.position,
          );
        }
      },
    });
    const cancelScroll =
      this.scrollContainer != null
        ? autoScrollOnBoundary(
            this.scrollContainer,
            computed(() => {
              return {
                left: drag.mousePosition.value.x,
                right: drag.mousePosition.value.x,
                top: drag.mousePosition.value.y,
                bottom: drag.mousePosition.value.y,
              };
            }),
          )
        : () => {};
  };

  get host() {
    return this.logic.ui$.value;
  }

  /**
   * Aktuelle `ViewportContext` (P-VIRG-ARCH-E-02). Wird an die
   * Drop-Indikator-Berechnung durchgereicht, damit der Indikator
   * im Edgeless-Modus korrekt auf der Karte landet.
   *
   * Defensiv: Test-Stubs der Logic haben evtl. kein
   * `currentViewport`. In dem Fall fallback auf PAGE_VIEWPORT.
   * Produktivcode hat die Methode via `DataViewUILogicBase`.
   */
  private get viewport(): ViewportContext {
    const fn = (this.logic as { currentViewport?: () => ViewportContext })
      .currentViewport;
    return typeof fn === "function" ? fn.call(this.logic) : PAGE_VIEWPORT;
  }

  /**
   * Stabile Drop-Indikator-Instanz. Viewport wird pro
   * `display`-Call frisch gelesen, damit Zoom-Aenderungen
   * waehrend des Drags greifen.
   */
  readonly dropPreview = createDropPreview();

  getInsertPosition = (
    evt: MouseEvent,
  ):
    | { group: KanbanGroup; card?: KanbanCard; position: InsertToPosition }
    | undefined => {
    const eles = document.elementsFromPoint(evt.x, evt.y);
    const target = eles.find((v) => v instanceof KanbanGroup) as KanbanGroup;
    if (target) {
      // P-VIRG-ARCH-E-02: Edgeless-Skalierung. `evt.y` ist in
      // CSS-Pixeln, `getBoundingClientRect()` ebenfalls. Beide
      // Seiten CSS-Pixel -> Vergleich identisch zu vor E-02.
      // Die `viewport` wird hier nur konsumiert, damit zukuenftige
      // Pan-Offset-Adapter (E-FIND-06) ohne API-Bruch anhaengen
      // koennen.
      const card = getCardByPoint(target, evt.y, this.viewport);
      return {
        group: target,
        card,
        position: card
          ? {
              before: true,
              id: card.cardId,
            }
          : "end",
      };
    } else {
      return;
    }
  };

  showIndicator = (
    evt: MouseEvent,
    self: KanbanCard | undefined,
  ): { group: KanbanGroup; position: InsertToPosition } | undefined => {
    const position = this.getInsertPosition(evt);
    if (position) {
      this.dropPreview.display(
        position.group,
        self,
        position.card,
        this.viewport,
      );
    } else {
      this.dropPreview.remove();
    }
    return position;
  };

  get scrollContainer() {
    const scrollContainer = this.logic.scrollContainer$.value;
    return scrollContainer;
  }

  constructor(private readonly logic: KanbanViewUILogic) {}

  hostConnected() {
    if (this.logic.view.readonly$.value) {
      return;
    }
    if (this.host) {
      this.host.disposables.add(
        this.logic.handleEvent("dragStart", (context) => {
          const event = context.get("pointerState").raw;
          const target = event.target;
          if (target instanceof Element) {
            const cell = target.closest("myoxus-data-view-kanban-cell");
            if (cell?.isEditing$.value) {
              return;
            }
            cell?.selectCurrentCell(false);
            const card = target.closest("myoxus-data-view-kanban-card");
            if (card) {
              this.dragStart(card, event);
            }
          }
          return true;
        }),
      );
    }
  }
}

const createDragPreview = (card: KanbanCard, x: number, y: number) => {
  const preOpacity = card.style.opacity;
  card.style.opacity = "0.5";
  const div = document.createElement("div");
  const kanbanCard = new KanbanCard();
  kanbanCard.cardId = card.cardId;
  kanbanCard.kanbanViewLogic = card.kanbanViewLogic;
  kanbanCard.isFocus$.value = true;
  kanbanCard.style.backgroundColor = "var(--myoxus-background-primary-color)";
  div.append(kanbanCard);
  div.className = "with-data-view-css-variable";
  div.style.width = `${card.getBoundingClientRect().width}px`;
  div.style.position = "fixed";
  div.style.pointerEvents = "none";
  div.style.transform = "rotate(-3deg)";
  div.style.left = `${x}px`;
  div.style.top = `${y}px`;
  div.style.zIndex = "9999";
  document.body.append(div);
  return {
    display(x: number, y: number) {
      div.style.left = `${Math.round(x)}px`;
      div.style.top = `${Math.round(y)}px`;
    },
    remove() {
      card.style.opacity = preOpacity;
      div.remove();
    },
  };
};
const createDropPreview = () => {
  const div = document.createElement("div");
  div.dataset.isDropPreview = "true";
  div.style.pointerEvents = "none";
  div.style.position = "fixed";
  div.style.zIndex = "9999";
  div.style.height = "3px";
  div.style.borderRadius = "2px";
  div.style.backgroundColor = "var(--myoxus-primary-color)";
  div.style.boxShadow = "0px 0px 8px 0px rgba(30, 150, 235, 0.35)";
  return {
    display(
      group: KanbanGroup,
      self: KanbanCard | undefined,
      card: KanbanCard | undefined,
      ctx: ViewportContext,
    ) {
      if (card === self) {
        div.remove();
        return;
      }

      if (!card) {
        const cards = Array.from(
          group.querySelectorAll("myoxus-data-view-kanban-card"),
        );
        const lastCard = cards[cards.length - 1];
        if (lastCard === self) {
          div.remove();
          return;
        }
      }

      let rect: DOMRect | undefined;
      let y = 0;
      if (card) {
        rect = card.getBoundingClientRect();
        y = rect.top;
      } else {
        const addCard = group.querySelector(".add-card");
        if (addCard instanceof HTMLElement) {
          rect = addCard.getBoundingClientRect();
          y = rect.top;
        }
      }
      if (!rect) {
        const body = group.querySelector(".group-body");
        if (body instanceof HTMLElement) {
          rect = body.getBoundingClientRect();
          y = rect.bottom;
        }
      }
      if (!rect) {
        div.remove();
        return;
      }

      // P-VIRG-ARCH-E-02: Edgeless-Adapter konsumiert den Rect
      // und die `ViewportContext`. Aktuell no-op (CSS-Pixel sind
      // korrekt fuer das `position: fixed`-Overlay), aber der
      // Adapter-Pfad ist jetzt konsistent mit E-02-FIND-08
      // vorbereitet, sobald Pan-Offset (E-FIND-06) ins Spiel kommt.
      const r = dropIndicatorRectInCanvas(rect, ctx);
      document.body.append(div);
      div.style.left = `${Math.round(r.left)}px`;
      div.style.top = `${Math.round(y - 2)}px`;
      div.style.width = `${Math.round(r.width)}px`;
    },
    remove() {
      div.remove();
    },
  };
};

const getCardByPoint = (
  group: KanbanGroup,
  y: number,
  ctx: ViewportContext,
): KanbanCard | undefined => {
  const cards = Array.from(
    group.querySelectorAll("myoxus-data-view-kanban-card"),
  );
  // P-VIRG-ARCH-E-02: Edgeless-Adapter liefert die Midpoints im
  // konsistenten Koordinatenraum. Aktuell CSS-Pixel (siehe
  // `cardMidpointsInCanvas`-Doku), Edgeless-Skalierung wirkt
  // symmetrisch auf Cards und `evt.y`. Sobald Pan-Offset
  // dazukommt, teilt der Adapter die Werte durch `ctx.scale`.
  const positions = cardMidpointsInCanvas(cards, ctx);
  const index = positions.findIndex((v) => v > y);
  return cards[index];
};
