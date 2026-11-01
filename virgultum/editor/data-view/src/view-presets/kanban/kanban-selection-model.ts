// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-selection-model.ts` - P-VIRG-ARCH-E-01.
 *
 * Pure Model fuer Kanban-Selection-State-Transitions und Navigation.
 *
 * **Pflicht:**
 *   - Keine DOM-Queries, keine Lit- oder Web-Component-Importe.
 *   - Keine `host.querySelector`, `getBoundingClientRect` o.ae.
 *   - Jede Funktion ist eine reine Funktion der Eingabe-Typen und
 *     einer explizit uebergebenen `KanbanTopology`.
 *
 * **Schuetzt:**
 *   - Card-Toggle (shift+click), Card-Add, Card-Remove.
 *   - Cell-Edit-Mode-Transitions (enter / exit).
 *   - Cell <-> Card Konvertierungen.
 *   - Up/Down/Left/Right-Navigation (gleiche Gruppe + Gruppenwechsel)
 *     mit abstrakter Topology.
 *
 * **Folgejobs (E-02 / G-XX):**
 *   - Geometrische Navigation (Bounding-Box-Vergleich beim
 *     Gruppenwechsel) bleibt im DOM-Adapter, bis der Edgeless-
 *     Adapter die Bounds-Berechnung uebernimmt.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-01)
 */

import type {
  KanbanCardSelection,
  KanbanCardSelectionCard,
  KanbanCellSelection,
  KanbanViewSelection,
} from "./selection.js";
import { nonEmptyCards } from "./selection.js";

// Re-Export noetig fuer Aufrufer, die Cell-Selection konstruieren.
export type { KanbanCardSelectionCard };

/**
 * Abstrakte Beschreibung der Kanban-Board-Topologie. Wird dem
 * Modell uebergeben, damit Navigationsentscheidungen ohne DOM
 * getroffen werden koennen.
 *
 * **Invarianten:**
 *   - `groupCards.get(key)` ist definiert fuer jeden `groupKey` in
 *     `groupKeys`. Reihenfolge = top-to-bottom.
 *   - `cardColumns.get(cardId)` ist definiert fuer jede vorkommende
 *     `cardId`. Reihenfolge = left-to-right.
 *   - `columnId` in `KanbanCellSelection` MUSS in
 *     `cardColumns.get(cardId)` enthalten sein, sonst liefern
 *     `nextCellInDirection` etc. `undefined`.
 */
export interface KanbanTopology {
  readonly groupKeys: readonly string[];
  readonly groupCards: ReadonlyMap<string, readonly string[]>;
  readonly cardColumns: ReadonlyMap<string, readonly string[]>;
}

// =====================================================================
// Card-Selection-Operationen
// =====================================================================

/**
 * Fuegt eine Karte zu einer bestehenden Card-Selection hinzu. Wenn
 * die Karte schon enthalten ist, wird sie NICHT doppelt eingefuegt
 * (Mengen-Semantik mit Reihenfolgegarantie).
 */
export function addCardToSelection(
  current: KanbanCardSelection,
  card: KanbanCardSelectionCard,
): KanbanCardSelection {
  if (current.cards.some((c) => c.cardId === card.cardId)) {
    return current;
  }
  return {
    selectionType: "card",
    cards: [...current.cards, card],
  };
}

/**
 * Entfernt eine Karte aus der Selection. Liefert `undefined`, wenn
 * die resultierende Liste leer ist (kein "card mit 0 Karten"-State).
 */
export function removeCardFromSelection(
  current: KanbanCardSelection,
  cardId: string,
): KanbanCardSelection | undefined {
  const filtered = current.cards.filter((c) => c.cardId !== cardId);
  const cards = nonEmptyCards(filtered);
  if (!cards) return undefined;
  return {
    selectionType: "card",
    cards,
  };
}

/**
 * Shift-Click-Toggle: Karte ist enthalten -> entfernen; sonst ->
 * anhaengen. Liefert `undefined`, wenn die Karte entfernt wird und
 * die Liste danach leer ist.
 */
export function toggleCardInSelection(
  current: KanbanViewSelection | undefined,
  card: KanbanCardSelectionCard,
): KanbanViewSelection | undefined {
  if (!current) {
    return {
      selectionType: "card",
      cards: [card],
    };
  }
  if (current.selectionType === "cell") {
    // Aus Cell-Selection wird eine Card-Selection mit der Karte.
    return {
      selectionType: "card",
      cards: [{ groupKey: current.groupKey, cardId: current.cardId }, card],
    };
  }
  if (current.selectionType === "group") {
    // Group-Selection ohne Card-Bezug: in Card-Selection ueberfuehren.
    return {
      selectionType: "card",
      cards: [card],
    };
  }
  // Card-Selection: toggle.
  return current.cards.some((c) => c.cardId === card.cardId)
    ? removeCardFromSelection(current, card.cardId)
    : addCardToSelection(current, card);
}

// =====================================================================
// Cell-Editing-Transitions
// =====================================================================

/** Cell-Editing-Modus anschalten. Pure: setzt `isEditing = true`. */
export function enterCellEditing(
  current: KanbanCellSelection,
): KanbanCellSelection {
  return { ...current, isEditing: true };
}

/** Cell-Editing-Modus ausschalten. Pure: setzt `isEditing = false`. */
export function exitCellEditing(
  current: KanbanCellSelection,
): KanbanCellSelection {
  return { ...current, isEditing: false };
}

// =====================================================================
// Cell <-> Card Konvertierung
// =====================================================================

/** Wandelt eine Cell-Selection in eine Card-Selection (gleiche Karte). */
export function cellToCardSelection(
  cell: KanbanCellSelection,
): KanbanCardSelection {
  return {
    selectionType: "card",
    cards: [{ groupKey: cell.groupKey, cardId: cell.cardId }],
  };
}

/**
 * Nimmt die erste Karte einer Card-Selection und macht daraus eine
 * Cell-Selection auf der angegebenen Spalte. Liefert `undefined`,
 * wenn die Card-Selection leer ist.
 */
export function firstCardToCellSelection(
  card: KanbanCardSelection,
  columnId: string,
): KanbanCellSelection | undefined {
  const first = card.cards[0];
  if (!first) return undefined;
  return {
    selectionType: "cell",
    groupKey: first.groupKey,
    cardId: first.cardId,
    columnId,
    isEditing: false,
  };
}

// (Re-Export noetig fuer Aufrufer, die Cell-Selection konstruieren.)

/**
 * Wie `firstCardToCellSelection`, waehlt aber automatisch die erste
 * verfuegbare Spalte der Karte. Liefert `undefined`, wenn die
 * Karte keine Spalten hat (sollte nicht vorkommen, ist aber
 * defensiv).
 */
export function firstCardToFirstCell(
  card: KanbanCardSelection,
  topology: KanbanTopology,
): KanbanCellSelection | undefined {
  const first = card.cards[0];
  if (!first) return undefined;
  const columns = topology.cardColumns.get(first.cardId);
  const firstColumnId = columns?.[0];
  if (!firstColumnId) return undefined;
  return {
    selectionType: "cell",
    groupKey: first.groupKey,
    cardId: first.cardId,
    columnId: firstColumnId,
    isEditing: false,
  };
}

// =====================================================================
// Navigation (topologiegetrieben)
// =====================================================================

/**
 * Cell-Navigation in eine Richtung. Liefert `undefined`, wenn
 * die Ziel-Zelle ausserhalb der Topology liegt.
 *
 * **Reihenfolge:**
 *   - `up`/`down`: gleiche Spalte, andere Karte in gleicher Gruppe.
 *     Wenn oben/unten erschoepft: wrap zur letzten/ersten Karte.
 *   - `left`/`right`: gleiche Karte, andere Spalte.
 *     Wenn links/rechts erschoepft: Gruppe wechseln (topologisch,
 *       nicht geometrisch). Folgejob E-02 uebernimmt die
 *       geometrische Y-Offset-Heuristik.
 */
export function nextCellInDirection(
  current: KanbanCellSelection,
  direction: "up" | "down" | "left" | "right",
  topology: KanbanTopology,
): KanbanCellSelection | undefined {
  const cardsInGroup = topology.groupCards.get(current.groupKey) ?? [];
  const cardIndex = cardsInGroup.indexOf(current.cardId);

  if (direction === "up" || direction === "down") {
    if (cardIndex < 0) return undefined;
    const offset = direction === "up" ? -1 : 1;
    const nextIndex = wrapIndex(cardIndex + offset, cardsInGroup.length);
    const nextCardId = cardsInGroup[nextIndex];
    if (!nextCardId) return undefined;
    return {
      selectionType: "cell",
      groupKey: current.groupKey,
      cardId: nextCardId,
      columnId: current.columnId,
      isEditing: false,
    };
  }

  // left/right: gleiche Karte, andere Spalte; oder Gruppenwechsel.
  const columns = topology.cardColumns.get(current.cardId) ?? [];
  const colIndex = columns.indexOf(current.columnId);

  // Spalten-Offset mit harter Boundary (kein Wrap auf gleicher Karte,
  // wenn am Rand -> Gruppe wechseln).
  const offset = direction === "left" ? -1 : 1;
  const targetColIndex = colIndex + offset;
  const inBounds =
    colIndex >= 0 && targetColIndex >= 0 && targetColIndex < columns.length;

  if (inBounds) {
    const nextColumnId = columns[targetColIndex];
    if (nextColumnId !== undefined) {
      return {
        selectionType: "cell",
        groupKey: current.groupKey,
        cardId: current.cardId,
        columnId: nextColumnId,
        isEditing: false,
      };
    }
  }

  // Spalte erschoepft: Gruppe wechseln.
  const groupIndex = topology.groupKeys.indexOf(current.groupKey);
  if (groupIndex < 0) return undefined;
  const groupOffset = direction === "left" ? -1 : 1;
  const nextGroupIndex = wrapIndex(
    groupIndex + groupOffset,
    topology.groupKeys.length,
  );
  const nextGroupKey = topology.groupKeys[nextGroupIndex];
  if (!nextGroupKey) return undefined;
  // Im Gruppenwechsel bleibt die Karte dieselbe, falls vorhanden;
  // sonst erste Karte der naechsten Gruppe.
  const nextCards = topology.groupCards.get(nextGroupKey) ?? [];
  const nextCardId = nextCards.includes(current.cardId)
    ? current.cardId
    : nextCards[0];
  if (!nextCardId) return undefined;
  // Spalte beibehalten, falls die neue Karte sie hat; sonst erste.
  const nextColumns = topology.cardColumns.get(nextCardId) ?? [];
  const nextColumnId = nextColumns.includes(current.columnId)
    ? current.columnId
    : nextColumns[0];
  if (!nextColumnId) return undefined;
  return {
    selectionType: "cell",
    groupKey: nextGroupKey,
    cardId: nextCardId,
    columnId: nextColumnId,
    isEditing: false,
  };
}

/**
 * Card-Navigation in eine Richtung. Liefert `undefined`, wenn
 * keine gueltige Ziel-Karte existiert.
 *
 * **Reihenfolge:** wie `nextCellInDirection`, nur ohne Spalten-
 * Auswahl (Karten sind atomar).
 */
export function nextCardInDirection(
  current: KanbanCardSelection,
  direction: "up" | "down" | "left" | "right",
  topology: KanbanTopology,
): KanbanCardSelection | undefined {
  const first = current.cards[0];
  if (!first) return undefined;
  const cardsInGroup = topology.groupCards.get(first.groupKey) ?? [];
  const cardIndex = cardsInGroup.indexOf(first.cardId);

  if (direction === "up" || direction === "down") {
    if (cardIndex < 0) return undefined;
    const offset = direction === "up" ? -1 : 1;
    const nextIndex = wrapIndex(cardIndex + offset, cardsInGroup.length);
    const nextCardId = cardsInGroup[nextIndex];
    if (!nextCardId) return undefined;
    return {
      selectionType: "card",
      cards: [{ groupKey: first.groupKey, cardId: nextCardId }],
    };
  }

  // left/right: Gruppe wechseln.
  const groupIndex = topology.groupKeys.indexOf(first.groupKey);
  if (groupIndex < 0) return undefined;
  const groupOffset = direction === "left" ? -1 : 1;
  const nextGroupIndex = wrapIndex(
    groupIndex + groupOffset,
    topology.groupKeys.length,
  );
  const nextGroupKey = topology.groupKeys[nextGroupIndex];
  if (!nextGroupKey) return undefined;
  const nextCards = topology.groupCards.get(nextGroupKey) ?? [];
  const nextCardId = nextCards[0];
  if (!nextCardId) return undefined;
  return {
    selectionType: "card",
    cards: [{ groupKey: nextGroupKey, cardId: nextCardId }],
  };
}

// =====================================================================
// Focus-In / Focus-Out Transitions
// =====================================================================

/**
 * `focusOutTransform` - ueberfuehrt eine Selection in den naechsten
 * stabilen Zustand, wenn der Fokus den Kanban-Bereich verlaesst.
 *
 * - `cell` (mit `isEditing = true`): Editing-Modus verlassen
 *   (bleibt Cell, isEditing = false).
 * - `cell` (mit `isEditing = false`): wird zur Card-Selection.
 * - `card`: auf das erste Element reduziert.
 * - `group`: bleibt group.
 * - `undefined`: bleibt undefined.
 */
export function focusOutTransform(
  current: KanbanViewSelection | undefined,
): KanbanViewSelection | undefined {
  if (!current) return undefined;
  if (current.selectionType === "cell") {
    if (current.isEditing) {
      return exitCellEditing(current);
    }
    return cellToCardSelection(current);
  }
  if (current.selectionType === "card") {
    if (current.cards.length === 0) return undefined;
    return {
      ...current,
      cards: [current.cards[0]!],
    };
  }
  return current;
}

/**
 * `focusInTransform` - ueberfuehrt eine Selection in den "tiefsten"
 * Zustand, wenn der Fokus in den Kanban-Bereich zurueckkehrt.
 *
 * - `cell` (mit `isEditing = false`): wird in Edit-Modus gesetzt.
 * - `cell` (mit `isEditing = true`): bleibt.
 * - `card`: wird zur Cell-Selection auf der ersten verfuegbaren
 *   Spalte der ersten Karte (topologiegetrieben).
 * - `group` / `undefined`: bleibt.
 */
export function focusInTransform(
  current: KanbanViewSelection | undefined,
  topology: KanbanTopology,
): KanbanViewSelection | undefined {
  if (!current) return undefined;
  if (current.selectionType === "cell") {
    return current.isEditing ? current : enterCellEditing(current);
  }
  if (current.selectionType === "card") {
    return firstCardToFirstCell(current, topology) ?? current;
  }
  return current;
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Wrappt einen Index in `[0, length)`. `length > 0` ist Aufrufer-
 * Pflicht; fuer `length === 0` liefert die Funktion `0`, was der
 * Aufrufer selbst pruefen muss.
 */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
