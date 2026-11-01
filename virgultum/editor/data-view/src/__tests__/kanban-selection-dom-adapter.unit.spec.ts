// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-selection-dom-adapter.unit.spec.ts` - P-VIRG-ARCH-E-01.
 *
 * Tests fuer `kanban-selection-dom-adapter.ts` mit happy-dom.
 * Verifiziert nur das Mapping zwischen DOM-Elementen und Selection-
 * Typen - KEINE algebraische Selection-Logik (die lebt im pure
 * model).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-01)
 */

import { describe, expect, it } from "vitest";

import {
  findClosestCardByYOffset,
  findClosestCellByYOffset,
  findNextNonEmptyGroup,
  getCardForCellSelection,
  getCardsForCardSelection,
  getCellForCellSelection,
  readKanbanTopology,
} from "../view-presets/kanban/kanban-selection-dom-adapter.js";
import type { KanbanCard } from "../view-presets/kanban/pc/card.js";
import type {
  KanbanCardSelection,
  KanbanCellSelection,
} from "../view-presets/kanban/selection.js";

/** happy-dom haengt Elemente an `document.body` an; zwischen Tests
 *  aufrauemen, damit kein State-Leak passiert. */
function resetBody() {
  while (document.body.firstChild) {
    document.body.firstChild.remove();
  }
}

/**
 * Baut eine minimale Kanban-Board-Struktur im happy-dom und liefert
 * den Wurzel-Knoten sowie eine Map von Karten-IDs zu Mock-Elementen
 * fuer `getBoundingClientRect`-Manipulationen.
 */
function buildBoard(opts: {
  groups: { key: string; cards: { id: string; columns: string[] }[] }[];
}): {
  root: HTMLElement;
  rects: Map<string, DOMRect>;
} {
  const root = document.createElement("div");
  root.dataset.myoxusViewRoot = "true";
  const rects = new Map<string, DOMRect>();

  for (const group of opts.groups) {
    const groupEl = document.createElement("myoxus-data-view-kanban-group");
    groupEl.dataset.key = group.key;
    // Simulierter `group.key` Property-Zugriff (Lit web component).
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

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: readKanbanTopology", () => {
  it("liest Gruppen, Karten und Spalten in Document-Order", () => {
    const { root } = buildBoard({
      groups: [
        { key: "A", cards: [{ id: "a1", columns: ["name", "status"] }] },
        { key: "B", cards: [{ id: "b1", columns: ["name"] }] },
      ],
    });
    const topology = readKanbanTopology(root);
    expect(topology.groupKeys).toEqual(["A", "B"]);
    expect(topology.groupCards.get("A")).toEqual(["a1"]);
    expect(topology.groupCards.get("B")).toEqual(["b1"]);
    expect(topology.cardColumns.get("a1")).toEqual(["name", "status"]);
    expect(topology.cardColumns.get("b1")).toEqual(["name"]);
  });

  it("ignoriert Gruppen ohne key", () => {
    resetBody();
    const group = document.createElement("myoxus-data-view-kanban-group");
    // .group.key fehlt bewusst
    document.body.append(group);
    const topology = readKanbanTopology(document.body);
    expect(topology.groupKeys).toEqual([]);
  });

  it("ignoriert Karten ohne cardId", () => {
    resetBody();
    const group = document.createElement("myoxus-data-view-kanban-group");
    group.dataset.key = "A";
    (group as unknown as { group: { key: string; rows: unknown[] } }).group = {
      key: "A",
      rows: [],
    };
    const card = document.createElement("myoxus-data-view-kanban-card");
    // cardId fehlt
    group.append(card);
    document.body.append(group);
    const topology = readKanbanTopology(document.body);
    expect(topology.groupCards.get("A")).toEqual([]);
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: getCardForCellSelection", () => {
  it("liefert die Karte fuer eine gueltige Cell-Selection", () => {
    const { root } = buildBoard({
      groups: [{ key: "A", cards: [{ id: "a1", columns: ["name"] }] }],
    });
    const selection: KanbanCellSelection = {
      selectionType: "cell",
      groupKey: "A",
      cardId: "a1",
      columnId: "name",
      isEditing: false,
    };
    const card = getCardForCellSelection(root, selection);
    expect(card).not.toBeNull();
    expect((card as unknown as { cardId: string }).cardId).toBe("a1");
  });

  it("liefert null fuer unbekannte groupKey", () => {
    const { root } = buildBoard({
      groups: [{ key: "A", cards: [{ id: "a1", columns: ["name"] }] }],
    });
    const selection: KanbanCellSelection = {
      selectionType: "cell",
      groupKey: "X",
      cardId: "a1",
      columnId: "name",
      isEditing: false,
    };
    expect(getCardForCellSelection(root, selection)).toBeNull();
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: getCellForCellSelection", () => {
  it("liefert die Cell-Element fuer gueltige Cell-Selection", () => {
    const { root } = buildBoard({
      groups: [
        { key: "A", cards: [{ id: "a1", columns: ["name", "status"] }] },
      ],
    });
    const selection: KanbanCellSelection = {
      selectionType: "cell",
      groupKey: "A",
      cardId: "a1",
      columnId: "status",
      isEditing: false,
    };
    const cell = getCellForCellSelection(root, selection);
    expect(cell).not.toBeNull();
    expect((cell as unknown as { column: { id: string } }).column.id).toBe(
      "status",
    );
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: getCardsForCardSelection", () => {
  it("liefert die Karten fuer eine Card-Selection", () => {
    const { root } = buildBoard({
      groups: [
        {
          key: "A",
          cards: [
            { id: "a1", columns: ["name"] },
            { id: "a2", columns: ["name"] },
          ],
        },
      ],
    });
    const selection: KanbanCardSelection = {
      selectionType: "card",
      cards: [
        { groupKey: "A", cardId: "a1" },
        { groupKey: "A", cardId: "a2" },
      ],
    };
    const cards = getCardsForCardSelection(root, selection);
    expect(cards.length).toBe(2);
  });

  it("liefert leere Liste fuer Group-Selection", () => {
    const { root } = buildBoard({
      groups: [{ key: "A", cards: [{ id: "a1", columns: ["name"] }] }],
    });
    const selection = {
      selectionType: "group" as const,
      groupKeys: ["A"] as [string, ...string[]],
    };
    expect(getCardsForCardSelection(root, selection)).toEqual([]);
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: findClosestCardByYOffset", () => {
  it("waehlt die Karte mit minimalem Y-Abstand", () => {
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
    rects.set("card:b2", makeRect(0, 200, 100, 40));
    rects.set("card:b3", makeRect(0, 300, 100, 40));
    const currentRect = makeRect(0, 220, 100, 40); // Mitte ~240, am naechsten zu b2
    const card = findClosestCardByYOffset(root, currentRect, "B");
    expect((card as unknown as { cardId: string }).cardId).toBe("b2");
  });

  it("liefert null fuer unbekannte Gruppe", () => {
    const { root } = buildBoard({
      groups: [{ key: "A", cards: [{ id: "a1", columns: ["name"] }] }],
    });
    expect(
      findClosestCardByYOffset(root, makeRect(0, 0, 100, 40), "X"),
    ).toBeNull();
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: findNextNonEmptyGroup", () => {
  it("findet die naechste nichtleere Gruppe (rechts)", () => {
    const { root } = buildBoard({
      groups: [
        { key: "A", cards: [{ id: "a1", columns: ["name"] }] },
        { key: "B", cards: [{ id: "b1", columns: ["name"] }] },
      ],
    });
    const next = findNextNonEmptyGroup(root, "A", "right");
    expect(next).not.toBeNull();
    expect((next as unknown as { group: { key: string } }).group.key).toBe("B");
  });

  it("ueberspringt leere Gruppen", () => {
    const { root } = buildBoard({
      groups: [
        { key: "A", cards: [{ id: "a1", columns: ["name"] }] },
        { key: "B", cards: [] },
        { key: "C", cards: [{ id: "c1", columns: ["name"] }] },
      ],
    });
    const next = findNextNonEmptyGroup(root, "A", "right");
    expect((next as unknown as { group: { key: string } }).group.key).toBe("C");
  });

  it("liefert null wenn keine Gruppe existiert", () => {
    const { root } = buildBoard({ groups: [] });
    expect(findNextNonEmptyGroup(root, "A", "right")).toBeNull();
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection DOM adapter: findClosestCellByYOffset", () => {
  it("waehlt die Cell-Element mit minimalem Y-Abstand zur refRect", () => {
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

    const refRect = makeRect(0, 215, 100, 40); // Mitte ~235, am naechsten zu "status" (Mitte 220)
    const cell = findClosestCellByYOffset(
      cardEl as unknown as KanbanCard,
      refRect,
    );
    expect((cell as unknown as { column: { id: string } }).column.id).toBe(
      "status",
    );
  });

  it("liefert null fuer Karte ohne Cells", () => {
    const cardEl = document.createElement("myoxus-data-view-kanban-card");
    const refRect = makeRect(0, 0, 100, 40);
    const cell = findClosestCellByYOffset(
      cardEl as unknown as KanbanCard,
      refRect,
    );
    expect(cell).toBeNull();
  });
});

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
