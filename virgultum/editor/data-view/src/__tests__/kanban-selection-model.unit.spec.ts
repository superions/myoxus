// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-selection-model.unit.spec.ts` - P-VIRG-ARCH-E-01.
 *
 * Pure-Logic-Tests fuer `kanban-selection-model.ts`. Kein DOM,
 * keine Lit-Imports - die Topology wird als plain data gebaut.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-01)
 */

import { describe, expect, it } from "vitest";

import {
  addCardToSelection,
  cellToCardSelection,
  enterCellEditing,
  exitCellEditing,
  firstCardToCellSelection,
  firstCardToFirstCell,
  focusInTransform,
  focusOutTransform,
  type KanbanTopology,
  nextCardInDirection,
  nextCellInDirection,
  removeCardFromSelection,
  toggleCardInSelection,
} from "../view-presets/kanban/kanban-selection-model.js";
import type {
  KanbanCardSelection,
  KanbanCellSelection,
  KanbanViewSelection,
} from "../view-presets/kanban/selection.js";

/**
 * 3 Gruppen x 3 Karten x 2 Spalten Topology. Wird in den meisten
 * Tests wiederverwendet:
 *
 *   group A: [a1, a2, a3]
 *   group B: [b1, b2, b3]
 *   group C: [c1, c2, c3]
 *
 *   Jede Karte hat Spalten ["name", "status"].
 */
function makeBoard(): KanbanTopology {
  const groups = ["A", "B", "C"] as const;
  const groupCards = new Map<string, readonly string[]>([
    ["A", ["a1", "a2", "a3"]],
    ["B", ["b1", "b2", "b3"]],
    ["C", ["c1", "c2", "c3"]],
  ]);
  const cardColumns = new Map<string, readonly string[]>();
  for (const groupKey of groups) {
    for (const cardId of groupCards.get(groupKey) ?? []) {
      cardColumns.set(cardId, ["name", "status"]);
    }
  }
  return {
    groupKeys: groups,
    groupCards,
    cardColumns,
  };
}

function cell(
  groupKey: string,
  cardId: string,
  columnId: string,
  isEditing = false,
): KanbanCellSelection {
  return { selectionType: "cell", groupKey, cardId, columnId, isEditing };
}

function cardSel(
  ...cards: { groupKey: string; cardId: string }[]
): KanbanCardSelection {
  return {
    selectionType: "card",
    cards: cards as KanbanCardSelection["cards"],
  };
}

describe("P-VIRG-ARCH-E-01 kanban selection model: card toggle", () => {
  it("addCardToSelection fuegt neue Karte an das Ende an", () => {
    const current = cardSel({ groupKey: "A", cardId: "a1" });
    const next = addCardToSelection(current, { groupKey: "A", cardId: "a2" });
    expect(next.cards.map((c) => c.cardId)).toEqual(["a1", "a2"]);
  });

  it("addCardToSelection ist idempotent fuer doppelte Karten", () => {
    const current = cardSel(
      { groupKey: "A", cardId: "a1" },
      { groupKey: "A", cardId: "a2" },
    );
    const next = addCardToSelection(current, { groupKey: "A", cardId: "a1" });
    expect(next).toBe(current);
  });

  it("removeCardFromSelection entfernt Karte und liefert undefined bei leerer Liste", () => {
    const current = cardSel({ groupKey: "A", cardId: "a1" });
    expect(removeCardFromSelection(current, "a1")).toBeUndefined();
  });

  it("removeCardFromSelection entfernt Karte und liefert Restliste", () => {
    const current = cardSel(
      { groupKey: "A", cardId: "a1" },
      { groupKey: "A", cardId: "a2" },
      { groupKey: "A", cardId: "a3" },
    );
    const next = removeCardFromSelection(current, "a2");
    expect(next?.cards.map((c) => c.cardId)).toEqual(["a1", "a3"]);
  });

  // E-FIND-03 / P-VIRG-ARCH-E-06: after removing one card from a
  // 2-card selection, the result is a 1-card selection. The
  // `[T, ...T[]]` shape must be preserved (this is the path the
  // `nonEmptyCards` helper centralises).
  it("removeCardFromSelection: 2 -> 1 cards bewahrt [T, ...T[]]-Form", () => {
    const current = cardSel(
      { groupKey: "A", cardId: "a1" },
      { groupKey: "A", cardId: "a2" },
    );
    const next = removeCardFromSelection(current, "a2");
    expect(next).toBeDefined();
    expect(next?.selectionType).toBe("card");
    if (next?.selectionType === "card") {
      // Static guarantee: `next.cards` is `[T, ...T[]]`, not `T[]`.
      // The destructuring with `...rest` is the compile-time test.
      const [head, ...rest] = next.cards;
      expect(head.cardId).toBe("a1");
      expect(rest).toEqual([]);
    }
  });

  it("toggleCardInSelection: undefined -> single-card", () => {
    const next = toggleCardInSelection(undefined, {
      groupKey: "A",
      cardId: "a1",
    });
    expect(next?.selectionType).toBe("card");
    expect(next?.selectionType === "card" ? next.cards : []).toEqual([
      { groupKey: "A", cardId: "a1" },
    ]);
  });

  it("toggleCardInSelection: vorhandene Karte -> weg", () => {
    const current = cardSel({ groupKey: "A", cardId: "a1" });
    const next = toggleCardInSelection(current, {
      groupKey: "A",
      cardId: "a1",
    });
    expect(next).toBeUndefined();
  });

  it("toggleCardInSelection: cell -> card mit zwei Karten", () => {
    const current = cell("A", "a1", "name");
    const next = toggleCardInSelection(current, {
      groupKey: "B",
      cardId: "b1",
    });
    expect(next?.selectionType).toBe("card");
    if (next?.selectionType === "card") {
      expect(next.cards).toEqual([
        { groupKey: "A", cardId: "a1" },
        { groupKey: "B", cardId: "b1" },
      ]);
    }
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection model: cell editing", () => {
  it("enterCellEditing setzt isEditing = true", () => {
    const next = enterCellEditing(cell("A", "a1", "name"));
    expect(next.isEditing).toBe(true);
  });

  it("exitCellEditing setzt isEditing = false", () => {
    const next = exitCellEditing(cell("A", "a1", "name", true));
    expect(next.isEditing).toBe(false);
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection model: cell <-> card conversion", () => {
  it("cellToCardSelection uebertraegt groupKey und cardId", () => {
    const next = cellToCardSelection(cell("B", "b2", "status"));
    expect(next).toEqual({
      selectionType: "card",
      cards: [{ groupKey: "B", cardId: "b2" }],
    });
  });

  it("firstCardToCellSelection liefert undefined fuer leere Card-Selection", () => {
    expect(
      firstCardToCellSelection(
        // @ts-expect-error: Test zwingend mit leerer Liste.
        { selectionType: "card", cards: [] },
        "name",
      ),
    ).toBeUndefined();
  });

  it("firstCardToCellSelection nimmt erste Karte und gewuenschte Spalte", () => {
    const next = firstCardToCellSelection(
      cardSel({ groupKey: "A", cardId: "a1" }, { groupKey: "A", cardId: "a2" }),
      "status",
    );
    expect(next).toEqual(cell("A", "a1", "status"));
  });

  it("firstCardToFirstCell waehlt erste Spalte der ersten Karte", () => {
    const board = makeBoard();
    const next = firstCardToFirstCell(
      cardSel({ groupKey: "A", cardId: "a2" }),
      board,
    );
    expect(next).toEqual(cell("A", "a2", "name"));
  });

  it("firstCardToFirstCell liefert undefined wenn Karte keine Spalten hat", () => {
    const board: KanbanTopology = {
      groupKeys: ["A"],
      groupCards: new Map([["A", ["a1"]]]),
      cardColumns: new Map(), // leer: a1 hat keine Spalten
    };
    expect(
      firstCardToFirstCell(cardSel({ groupKey: "A", cardId: "a1" }), board),
    ).toBeUndefined();
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection model: navigation", () => {
  it("nextCellInDirection up wechselt zur vorherigen Karte in der Gruppe", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a2", "name"), "up", board);
    expect(next).toEqual(cell("A", "a1", "name"));
  });

  it("nextCellInDirection down wechselt zur naechsten Karte in der Gruppe", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a1", "name"), "down", board);
    expect(next).toEqual(cell("A", "a2", "name"));
  });

  it("nextCellInDirection up wrappt zur letzten Karte der Gruppe", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a1", "name"), "up", board);
    expect(next).toEqual(cell("A", "a3", "name"));
  });

  it("nextCellInDirection down wrappt zur ersten Karte der Gruppe", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a3", "name"), "down", board);
    expect(next).toEqual(cell("A", "a1", "name"));
  });

  it("nextCellInDirection left wechselt zur vorherigen Spalte der gleichen Karte", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a1", "status"), "left", board);
    expect(next).toEqual(cell("A", "a1", "name"));
  });

  it("nextCellInDirection right wechselt zur naechsten Spalte der gleichen Karte", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a1", "name"), "right", board);
    expect(next).toEqual(cell("A", "a1", "status"));
  });

  it("nextCellInDirection right am Spaltenende wechselt in naechste Gruppe", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a1", "status"), "right", board);
    expect(next?.groupKey).toBe("B");
    expect(next?.cardId).toBe("b1");
    // gleiche Spalte, falls die neue Karte sie hat
    expect(next?.columnId).toBe("status");
  });

  it("nextCellInDirection left am Spaltenanfang wechselt in vorherige Gruppe (wrap)", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("A", "a1", "name"), "left", board);
    expect(next?.groupKey).toBe("C");
    expect(next?.cardId).toBe("c1");
    expect(next?.columnId).toBe("name");
  });

  it("nextCellInDirection setzt isEditing = false nach Navigation", () => {
    const board = makeBoard();
    const next = nextCellInDirection(
      cell("A", "a1", "name", true),
      "down",
      board,
    );
    expect(next?.isEditing).toBe(false);
  });

  it("nextCardInDirection up wechselt zur vorherigen Karte in der Gruppe", () => {
    const board = makeBoard();
    const next = nextCardInDirection(
      cardSel({ groupKey: "A", cardId: "a2" }),
      "up",
      board,
    );
    expect(next).toEqual(cardSel({ groupKey: "A", cardId: "a1" }));
  });

  it("nextCardInDirection right wechselt in naechste Gruppe, erste Karte", () => {
    const board = makeBoard();
    const next = nextCardInDirection(
      cardSel({ groupKey: "A", cardId: "a2" }),
      "right",
      board,
    );
    expect(next).toEqual(cardSel({ groupKey: "B", cardId: "b1" }));
  });

  it("nextCardInDirection left wrappt zur letzten Gruppe", () => {
    const board = makeBoard();
    const next = nextCardInDirection(
      cardSel({ groupKey: "A", cardId: "a1" }),
      "left",
      board,
    );
    expect(next).toEqual(cardSel({ groupKey: "C", cardId: "c1" }));
  });

  it("nextCellInDirection liefert undefined fuer unbekannte Karte", () => {
    const board = makeBoard();
    const next = nextCellInDirection(cell("X", "x1", "name"), "down", board);
    expect(next).toBeUndefined();
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection model: focus transforms", () => {
  it("focusOutTransform: cell editing -> cell not editing", () => {
    const next = focusOutTransform(cell("A", "a1", "name", true));
    expect(next?.selectionType).toBe("cell");
    if (next?.selectionType === "cell") {
      expect(next.isEditing).toBe(false);
    }
  });

  it("focusOutTransform: cell not editing -> card", () => {
    const next = focusOutTransform(cell("A", "a1", "name"));
    expect(next).toEqual({
      selectionType: "card",
      cards: [{ groupKey: "A", cardId: "a1" }],
    });
  });

  it("focusOutTransform: card mit mehreren Karten -> card mit erster Karte", () => {
    const next = focusOutTransform(
      cardSel(
        { groupKey: "A", cardId: "a1" },
        { groupKey: "A", cardId: "a2" },
        { groupKey: "A", cardId: "a3" },
      ),
    );
    expect(next).toEqual(cardSel({ groupKey: "A", cardId: "a1" }));
  });

  it("focusInTransform: cell not editing -> cell editing", () => {
    const board = makeBoard();
    const next = focusInTransform(cell("A", "a1", "name"), board);
    expect(next?.selectionType).toBe("cell");
    if (next?.selectionType === "cell") {
      expect(next.isEditing).toBe(true);
    }
  });

  it("focusInTransform: cell editing bleibt cell editing", () => {
    const board = makeBoard();
    const next = focusInTransform(cell("A", "a1", "name", true), board);
    expect(next).toEqual(cell("A", "a1", "name", true));
  });

  it("focusInTransform: card -> cell auf erster Spalte", () => {
    const board = makeBoard();
    const next = focusInTransform(
      cardSel({ groupKey: "B", cardId: "b2" }),
      board,
    );
    expect(next).toEqual(cell("B", "b2", "name"));
  });

  it("focusOutTransform(undefined) und focusInTransform(undefined) bleiben undefined", () => {
    expect(focusOutTransform(undefined)).toBeUndefined();
    const board = makeBoard();
    expect(focusInTransform(undefined, board)).toBeUndefined();
  });
});

describe("P-VIRG-ARCH-E-01 kanban selection model: types", () => {
  it("typed `KanbanViewSelection` enthaelt cell/card/group", () => {
    const a: KanbanViewSelection = cell("A", "a1", "name");
    const b: KanbanViewSelection = cardSel({ groupKey: "A", cardId: "a1" });
    const c: KanbanViewSelection = {
      selectionType: "group",
      groupKeys: ["A", "B"],
    };
    expect([a.selectionType, b.selectionType, c.selectionType]).toEqual([
      "cell",
      "card",
      "group",
    ]);
  });
});
