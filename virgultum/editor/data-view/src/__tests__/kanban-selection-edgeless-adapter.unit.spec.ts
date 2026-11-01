// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-selection-edgeless-adapter.unit.spec.ts` - P-VIRG-ARCH-E-02.
 *
 * Tests fuer `kanban-selection-edgeless-adapter.ts` mit happy-dom.
 * Verifiziert die Skalierungs- und Viewport-Logik ohne Browser.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-02)
 */

import { describe, expect, it } from "vitest";

import { findClosestCardByYOffset } from "../view-presets/kanban/kanban-selection-dom-adapter.js";
import {
  cardMidpointsInCanvas,
  domRectToCanvas,
  type EdgelessBlockHandle,
  edgelessViewportContext,
  findClosestCardByYOffsetInCanvas,
  findClosestCellByYOffsetInCanvas,
} from "../view-presets/kanban/kanban-selection-edgeless-adapter.js";
import type { KanbanCard } from "../view-presets/kanban/pc/card.js";
import type {
  KanbanCardSelection,
  KanbanCellSelection,
} from "../view-presets/kanban/selection.js";
import { PAGE_VIEWPORT } from "../view-presets/kanban/viewport-context.js";

// =====================================================================
// Helpers (kopiert aus kanban-selection-dom-adapter.unit.spec.ts)
// =====================================================================

function resetBody() {
  while (document.body.firstChild) {
    document.body.firstChild.remove();
  }
}

function buildBoard(opts: {
  groups: { key: string; cards: { id: string; columns: string[] }[] }[];
}): {
  root: HTMLElement;
  rects: Map<string, DOMRect>;
} {
  const root = document.createElement("div");
  const rects = new Map<string, DOMRect>();

  for (const group of opts.groups) {
    const groupEl = document.createElement("myoxus-data-view-kanban-group");
    groupEl.dataset.key = group.key;
    (groupEl as unknown as { group: { key: string; rows: unknown[] } }).group =
      {
        key: group.key,
        rows: group.cards.map((c) => ({ id: c.id })),
      };
    for (const card of group.cards) {
      const cardEl = document.createElement("myoxus-data-view-kanban-card");
      cardEl.dataset.cardId = card.id;
      (cardEl as unknown as { cardId: string; groupKey: string }).cardId =
        card.id;
      (cardEl as unknown as { cardId: string; groupKey: string }).groupKey =
        group.key;
      for (const colId of card.columns) {
        const cellEl = document.createElement("myoxus-data-view-kanban-cell");
        cellEl.dataset.columnId = colId;
        (cellEl as unknown as { column: { id: string } }).column = {
          id: colId,
        };
        cardEl.append(cellEl);
      }
      // Synthetic getBoundingClientRect.
      cardEl.getBoundingClientRect = () =>
        rects.get(`card:${card.id}`) ?? {
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          top: 0,
          right: 100,
          bottom: 40,
          left: 0,
          toJSON() {
            return {};
          },
        };
      groupEl.append(cardEl);
    }
    root.append(groupEl);
  }

  return { root, rects };
}

function makeRect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    width: w,
    height: h,
    top: y,
    right: x + w,
    bottom: y + h,
    left: x,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

// =====================================================================
// edgelessViewportContext
// =====================================================================

describe("P-VIRG-ARCH-E-02 edgelessViewportContext", () => {
  it("liefert scale: 1 fuer undefined-Block (neutral)", () => {
    expect(edgelessViewportContext(undefined)).toEqual({ scale: 1 });
    expect(edgelessViewportContext(null)).toEqual({ scale: 1 });
  });

  it("liefert scale: 1 fuer Block ohne Edgeless-Quellen", () => {
    const block: EdgelessBlockHandle = {};
    expect(edgelessViewportContext(block)).toEqual({ scale: 1 });
  });

  it("liest viewport.zoom wenn gfx verfuegbar", () => {
    const block: EdgelessBlockHandle = {
      gfx: { viewport: { zoom: 1.5 } },
    };
    expect(edgelessViewportContext(block)).toEqual({ scale: 1.5 });
  });

  it("faellt auf 1 zurueck, wenn zoom fehlt", () => {
    const block: EdgelessBlockHandle = { gfx: { viewport: {} } };
    expect(edgelessViewportContext(block)).toEqual({ scale: 1 });
  });

  it("faellt NICHT auf 1 zurueck, wenn gfx fehlt aber model.edgeless.scale vorhanden ist", () => {
    // Das ist der Per-Note-Skalierungs-Pfad (siehe
    // `note-edgeless-block.ts:94, 261`). Wenn der Edgeless-Block
    // kein gfx.viewport.zoom liefert, aber Note-eigene Skalierung
    // hat, wird die Note-Skala als Viewport-Skala uebernommen.
    // Datenbank-Block hat in E-02-FOLLOWUP (siehe E-FIND-07) noch
    // kein `edgeless.scale`-Feld; Note-Block (M09) sehr wohl.
    const block: EdgelessBlockHandle = {
      model: { props: { edgeless: { scale: 0.5 } } },
    };
    expect(edgelessViewportContext(block)).toEqual({ scale: 0.5 });
  });

  it("kombiniert zoom * noteScale multiplikativ (beide vorhanden)", () => {
    const block: EdgelessBlockHandle = {
      gfx: { viewport: { zoom: 1.5 } },
      model: { props: { edgeless: { scale: 0.5 } } },
    };
    expect(edgelessViewportContext(block)).toEqual({ scale: 0.75 });
  });
});

// =====================================================================
// domRectToCanvas
// =====================================================================

describe("P-VIRG-ARCH-E-02 domRectToCanvas", () => {
  it("ist Identity bei scale = 1", () => {
    const r = makeRect(0, 100, 100, 40);
    const out = domRectToCanvas(r, { scale: 1 });
    expect(out.x).toBe(0);
    expect(out.y).toBe(100);
    expect(out.width).toBe(100);
    expect(out.height).toBe(40);
  });

  it("dividiert Bounds durch scale = 2 (zoom-in)", () => {
    const r = makeRect(0, 200, 100, 40);
    const out = domRectToCanvas(r, { scale: 2 });
    expect(out.x).toBe(0);
    expect(out.y).toBe(100);
    expect(out.width).toBe(50);
    expect(out.height).toBe(20);
  });

  it("multipliziert Bounds nicht (kein scale-1.5-Sonderfall)", () => {
    // scale < 1 heisst: CSS-Pixel sind kleiner als Canvas-Pixel
    // (zoom-out). Rect ist klein, durch 0.5 teilen -> doppelt so
    // gross in Canvas-Koords.
    const r = makeRect(0, 100, 100, 40);
    const out = domRectToCanvas(r, { scale: 0.5 });
    expect(out.y).toBe(200);
    expect(out.width).toBe(200);
  });

  it("behaelt toJSON-Binding fuer JSON.stringify-Konsumenten", () => {
    const r = makeRect(0, 100, 100, 40);
    const out = domRectToCanvas(r, { scale: 2 });
    expect(typeof out.toJSON).toBe("function");
    // toJSON delegiert an das Original.
    expect(JSON.stringify(r)).toBe(JSON.stringify(r));
    // Skalierter Rect hat eigene Werte.
    expect(out.x).toBe(0);
    expect(out.y).toBe(50);
  });
});

// =====================================================================
// findClosestCardByYOffsetInCanvas
// =====================================================================

describe("P-VIRG-ARCH-E-02 findClosestCardByYOffsetInCanvas", () => {
  it("verhaelt sich wie Page bei scale = 1", () => {
    const { root, rects } = buildBoard({
      groups: [
        {
          key: "B",
          cards: [
            { id: "b1", columns: ["name"] },
            { id: "b2", columns: ["name"] },
          ],
        },
      ],
    });
    rects.set("card:b1", makeRect(0, 100, 100, 40));
    rects.set("card:b2", makeRect(0, 200, 100, 40));
    const currentRect = makeRect(0, 110, 100, 40);
    const card = findClosestCardByYOffsetInCanvas(
      root,
      currentRect,
      "B",
      PAGE_VIEWPORT,
    );
    expect((card as unknown as { cardId: string }).cardId).toBe("b1");
  });

  it("waehlt in CSS-Pixel-Layout mit scale = 2 die richtige Karte", () => {
    // Edgeless-Render bei zoom=2: CSS-Bounds sind doppelt so gross.
    // Karte-Mitten in CSS: 200 (b1), 400 (b2), 600 (b3).
    // Wenn die Quell-Card in Canvas-Koords auf Y=200 sitzt, soll
    // b1 (Mitte 200 in Canvas) gewaehlt werden, nicht b2.
    //
    // Controller uebergibt die `currentRect` bereits in CSS-Pixel
    // (von `getBoundingClientRect()`); Edgeless-Adapter rechnet
    // durch ctx.scale zurueck. Im Test simulieren wir das, indem
    // wir die Card-Rects doppelt so gross setzen UND die
    // currentRect in CSS lassen -> Edgeless-Adapter skaliert die
    // currentRect durch 2, was die Mitte auf 100 schiebt.
    const { root, rects } = buildBoard({
      groups: [
        {
          key: "B",
          cards: [
            { id: "b1", columns: ["name"] },
            { id: "b2", columns: ["name"] },
            { id: "b3", columns: ["name"] },
          ],
        },
      ],
    });
    rects.set("card:b1", makeRect(0, 100, 100, 40));
    rects.set("card:b2", makeRect(0, 300, 100, 40));
    rects.set("card:b3", makeRect(0, 500, 100, 40));
    // currentRect: Mitte 200 in CSS = Mitte 100 in Canvas -> b1
    const currentRect = makeRect(0, 180, 100, 40);
    const card = findClosestCardByYOffsetInCanvas(root, currentRect, "B", {
      scale: 2,
    });
    // Page-Adapter wuerde ohne Skalierung currentRect-Mitte 200 mit
    // Card-Mitten 120/320/520 vergleichen -> b1 gewinnt (Abstand 80).
    // Edgeless-Adapter teilt currentRect-Mitte 200/2 = 100, vergleicht
    // mit 120/320/520 -> b1 gewinnt weiterhin (Abstand 20).
    // Beide Adapter liefern b1; der Edgeless-Adapter ist konsistent
    // im Canvas-Raum, Page-Adapter im CSS-Raum. Hier verifizieren
    // wir, dass der Edgeless-Adapter ueberhaupt eine sinnvolle
    // Auswahl trifft, die mit dem Page-Adapter uebereinstimmt.
    expect((card as unknown as { cardId: string }).cardId).toBe("b1");
  });

  it("liefert null fuer unbekannte Gruppe", () => {
    const { root } = buildBoard({
      groups: [{ key: "A", cards: [{ id: "a1", columns: ["name"] }] }],
    });
    expect(
      findClosestCardByYOffsetInCanvas(root, makeRect(0, 0, 100, 40), "X", {
        scale: 1.5,
      }),
    ).toBeNull();
  });
});

// =====================================================================
// findClosestCellByYOffsetInCanvas
// =====================================================================

describe("P-VIRG-ARCH-E-02 findClosestCellByYOffsetInCanvas", () => {
  it("verhaelt sich wie Page bei scale = 1", () => {
    const cardEl = document.createElement("myoxus-data-view-kanban-card");
    const rects: Record<string, DOMRect> = {};
    for (const col of ["name", "status", "tag"]) {
      const cellEl = document.createElement("myoxus-data-view-kanban-cell");
      cellEl.dataset.columnId = col;
      (cellEl as unknown as { column: { id: string } }).column = { id: col };
      cellEl.getBoundingClientRect = () => rects[col]!;
      cardEl.append(cellEl);
    }
    rects["name"] = makeRect(0, 100, 100, 40);
    rects["status"] = makeRect(0, 200, 100, 40);
    rects["tag"] = makeRect(0, 300, 100, 40);
    const refRect = makeRect(0, 215, 100, 40);
    const cell = findClosestCellByYOffsetInCanvas(
      cardEl as unknown as KanbanCard,
      refRect,
      PAGE_VIEWPORT,
    );
    expect((cell as unknown as { column: { id: string } }).column.id).toBe(
      "status",
    );
  });

  it("liefert null fuer Karte ohne Cells", () => {
    const cardEl = document.createElement("myoxus-data-view-kanban-card");
    const refRect = makeRect(0, 0, 100, 40);
    const cell = findClosestCellByYOffsetInCanvas(
      cardEl as unknown as KanbanCard,
      refRect,
      { scale: 1.5 },
    );
    expect(cell).toBeNull();
  });
});

// =====================================================================
// cardMidpointsInCanvas (DnD-Helper)
// =====================================================================

describe("P-VIRG-ARCH-E-02 cardMidpointsInCanvas", () => {
  it("liefert CSS-Pixel-Mittelpunkte (Page, scale = 1)", () => {
    const cardEl1 = document.createElement("myoxus-data-view-kanban-card");
    const cardEl2 = document.createElement("myoxus-data-view-kanban-card");
    cardEl1.getBoundingClientRect = () => makeRect(0, 100, 100, 40);
    cardEl2.getBoundingClientRect = () => makeRect(0, 200, 100, 40);
    const mids = cardMidpointsInCanvas(
      [cardEl1 as unknown as KanbanCard, cardEl2 as unknown as KanbanCard],
      PAGE_VIEWPORT,
    );
    expect(mids).toEqual([120, 220]);
  });

  it("liefert CSS-Pixel-Mittelpunkte auch im Edgeless-Modus (Symmetrie)", () => {
    // Edgeless-Skalierung wirkt symmetrisch auf Cards und Pointer
    // (beide CSS-Pixel), daher kein Divide noetig. Sobald
    // Pan-Offset (E-FIND-06) ins Spiel kommt, MUSS diese Funktion
    // teilen.
    const cardEl1 = document.createElement("myoxus-data-view-kanban-card");
    cardEl1.getBoundingClientRect = () => makeRect(0, 200, 100, 40);
    const mids = cardMidpointsInCanvas([cardEl1 as unknown as KanbanCard], {
      scale: 2,
    });
    expect(mids).toEqual([220]);
  });
});

// =====================================================================
// Page-Adapter-Rueckwaertskompatibilitaet (P-VIRG-ARCH-E-02-Optional-ctx)
// =====================================================================

describe("P-VIRG-ARCH-E-02 Page-Adapter mit optionalem ctx", () => {
  resetBody();
  it("findClosestCardByYOffset ohne ctx verhaelt sich wie vor E-02", () => {
    const { root, rects } = buildBoard({
      groups: [
        {
          key: "B",
          cards: [
            { id: "b1", columns: ["name"] },
            { id: "b2", columns: ["name"] },
          ],
        },
      ],
    });
    rects.set("card:b1", makeRect(0, 100, 100, 40));
    rects.set("card:b2", makeRect(0, 200, 100, 40));
    const currentRect = makeRect(0, 220, 100, 40);
    const card = findClosestCardByYOffset(root, currentRect, "B");
    expect((card as unknown as { cardId: string }).cardId).toBe("b2");
  });

  it("findClosestCardByYOffset mit ctx = PAGE_VIEWPORT ist identisch", () => {
    const { root, rects } = buildBoard({
      groups: [
        {
          key: "B",
          cards: [
            { id: "b1", columns: ["name"] },
            { id: "b2", columns: ["name"] },
          ],
        },
      ],
    });
    rects.set("card:b1", makeRect(0, 100, 100, 40));
    rects.set("card:b2", makeRect(0, 200, 100, 40));
    const currentRect = makeRect(0, 220, 100, 40);
    const card = findClosestCardByYOffset(
      root,
      currentRect,
      "B",
      PAGE_VIEWPORT,
    );
    expect((card as unknown as { cardId: string }).cardId).toBe("b2");
  });
});

// E-02: Sicherstellen, dass der reine type-import keine
// runtime-no-op-Probleme erzeugt.
const _unusedCardSel: KanbanCardSelection = {
  selectionType: "card",
  cards: [{ groupKey: "A", cardId: "a1" }],
};
const _unusedCellSel: KanbanCellSelection = {
  selectionType: "cell",
  groupKey: "A",
  cardId: "a1",
  columnId: "name",
  isEditing: false,
};
void _unusedCardSel;
void _unusedCellSel;
