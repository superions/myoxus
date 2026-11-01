// SPDX-License-Identifier: MIT

/**
 * `selection.ts` - P-VIRG-ARCH-E-01 Kanban-Selection-Controller.
 *
 * Glue zwischen
 *   - `kanban-selection-model.ts` (pure Algebra, kein DOM) und
 *   - `kanban-selection-dom-adapter.ts` (Topology + Element-Lookup).
 *
 * **Verhalten:** identisch zur Pre-E-01-Implementierung. Der
 * Refactor extrahiert nur die algebraischen Operationen in das
 * Modell und die DOM-Queries in den Adapter.
 *
 * **P-VIRG-ARCH-E-02:** die geometrische Cross-Group-Heuristik
 * (Y-Offset) wurde in `kanban-selection-dom-adapter.ts` in Form
 * von `findClosestCardByYOffset` und `findClosestCellByYOffset`
 * konsolidiert. Der Controller reicht nur noch den
 * `ViewportContext` aus `this.logic.currentViewport()` durch
 * (`ctx`-Parameter, Default-Page-CSS-Pixel) — die Skalierungs-
 * Logik selbst lebt im Adapter.
 *
 * **Negativ-Abnahme:** Wenn `querySelector` direkt im Controller
 * auftaucht (ausser fuer den `host`-Selektor in Tests), ist der
 * Task nicht abgeschlossen.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-01)
 */

import type { ReactiveController } from "lit";

import {
  findClosestCardByYOffset,
  findClosestCellByYOffset,
  findNextNonEmptyGroup,
  getCardsForCardSelection,
  getCellForCellSelection,
  readKanbanTopology,
} from "../../kanban-selection-dom-adapter.js";
import {
  focusInTransform,
  focusOutTransform,
  type KanbanTopology,
  nextCardInDirection,
  nextCellInDirection,
  toggleCardInSelection,
} from "../../kanban-selection-model.js";
import {
  type KanbanCardSelection,
  type KanbanCardSelectionCard,
  type KanbanCellSelection,
  type KanbanViewSelection,
  type KanbanViewSelectionWithType,
  nonEmptyCards,
} from "../../selection.js";
import { KanbanCard } from "../card.js";
import type { KanbanGroup } from "../group.js";
import type { KanbanViewUILogic } from "../kanban-view-ui-logic.js";

export class KanbanSelectionController implements ReactiveController {
  private _selection?: KanbanViewSelectionWithType;

  shiftClickCard = (event: MouseEvent) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const closestCardId = target.closest(
      "myoxus-data-view-kanban-card",
    )?.cardId;
    const closestGroupKey = target.closest("myoxus-data-view-kanban-group")
      ?.group.key;
    if (!closestCardId || !closestGroupKey) return;
    // Pure Toggle via Modell.
    this.selection = toggleCardInSelection(this.selection, {
      cardId: closestCardId,
      groupKey: closestGroupKey,
    });
  };

  get selection(): KanbanViewSelectionWithType | undefined {
    return this._selection;
  }

  set selection(data: KanbanViewSelection | undefined) {
    const host = this.host;
    if (!host) {
      return;
    }
    if (!data) {
      this.logic.setSelection();
      return;
    }
    const selection: KanbanViewSelectionWithType = {
      ...data,
      viewId: this.logic.view.id,
      type: "kanban",
    };

    if (selection.selectionType === "cell" && selection.isEditing) {
      const cellEl = getCellForCellSelection(host, selection);
      const cell = cellEl?.cell;
      const isEditing = cell
        ? cell.beforeEnterEditMode()
          ? selection.isEditing
          : false
        : false;
      this.logic.setSelection({ ...selection, isEditing });
    } else {
      this.logic.setSelection(selection);
    }
  }

  get view() {
    return this.logic.view;
  }

  get host() {
    return this.logic.ui$.value;
  }

  constructor(public logic: KanbanViewUILogic) {}

  blur(selection: KanbanViewSelection) {
    const host = this.host;
    if (!host) {
      return;
    }
    if (selection.selectionType !== "cell") {
      const cards = getCardsForCardSelection(host, selection);
      cards.forEach((card) => (card.isFocus$.value = false));
      return;
    }
    const cellEl = getCellForCellSelection(host, selection);
    if (!cellEl) {
      return;
    }
    cellEl.isFocus$.value = false;
    const cell = cellEl.cell;

    if (selection.isEditing) {
      cell?.beforeExitEditingMode();
      if (cell?.blurCell()) {
        cellEl.blur();
      }
      cellEl.isEditing$.value = false;
    } else {
      cellEl.blur();
    }
  }

  clear() {
    this.selection = undefined;
  }

  deleteCard() {
    const selection = this.selection;
    if (!selection || selection.selectionType === "cell") {
      return;
    }
    if (selection.selectionType === "card") {
      this.view.rowsDelete(selection.cards.map((v) => v.cardId));
      this.selection = undefined;
      this.logic.ui$.value?.requestUpdate();
    }
  }

  focus(selection: KanbanViewSelection) {
    const host = this.host;
    if (!host) {
      return;
    }
    if (selection.selectionType !== "cell") {
      const cards = getCardsForCardSelection(host, selection);
      cards.forEach((card, index) => {
        if (index === 0) {
          card.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        card.isFocus$.value = true;
      });
      return;
    }
    const cellEl = getCellForCellSelection(host, selection);
    if (!cellEl) {
      return;
    }
    cellEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    cellEl.isFocus$.value = true;
    const cell = cellEl.cell;
    if (selection.isEditing) {
      if (cell?.focusCell()) {
        cellEl.focus();
      }
      cellEl.isEditing$.value = true;
      requestAnimationFrame(() => {
        cell?.afterEnterEditingMode();
      });
    } else {
      cellEl.focus();
    }
  }

  focusFirstCell() {
    const group = this.logic.groups$.value?.[0];
    const card = group?.rows[0];
    const columnId = card && this.view.getHeaderTitle(card.rowId)?.id;
    if (group && card && columnId) {
      this.selection = {
        selectionType: "cell",
        groupKey: group.key,
        cardId: card.rowId,
        columnId,
        isEditing: false,
      };
    }
  }

  focusIn() {
    const host = this.host;
    if (!host) {
      return;
    }
    const selection = this.selection;
    if (!selection) return;
    if (selection.selectionType === "cell" && selection.isEditing) return;
    // Pure transform via Modell + Topology-Adapter.
    const topology = readKanbanTopology(host);
    this.selection = focusInTransform(selection, topology);
  }

  focusNext(position: "up" | "down" | "left" | "right") {
    const host = this.host;
    if (!host) {
      return;
    }
    const selection = this.selection;
    if (!selection) {
      return;
    }

    const topology = readKanbanTopology(host);

    if (selection.selectionType === "cell" && !selection.isEditing) {
      const next = this.computeNextCellSelection(selection, position, topology);
      if (next) this.selection = next;
      return;
    }
    if (selection.selectionType === "card") {
      const next = this.computeNextCardSelection(selection, position, topology);
      if (next) this.selection = next;
    }
  }

  focusOut() {
    const selection = this.selection;
    if (!selection) return;
    this.selection = focusOutTransform(selection);
  }

  /**
   * Berechnet die naechste Cell-Selection in `direction`. Algebra
   * via Modell; Cross-Group-Geometrie (Y-Offset) via Adapter.
   *
   * P-VIRG-ARCH-E-02: Edgeless-Modus skaliert die Bounds via
   * `gfx.viewport.zoom`. Wir lesen die `ViewportContext` aus
   * `this.logic.currentViewport()` und reichen sie an den Adapter,
   * damit der Y-Offset-Vergleich im Canvas-Koordinatenraum laeuft.
   */
  private computeNextCellSelection(
    selection: KanbanCellSelection,
    direction: "up" | "down" | "left" | "right",
    topology: KanbanTopology,
  ): KanbanViewSelection | undefined {
    const next = nextCellInDirection(selection, direction, topology);
    if (next) return next;

    // Modell liefert `undefined` z.B. wenn die Spalte in der
    // naechsten Gruppe nicht existiert. Fallback: geometrisch die
    // naechste Gruppe suchen und Y-Offset-basiert die naechste
    // Karte+Zelle.
    if (direction !== "left" && direction !== "right") return undefined;
    const host = this.host;
    if (!host) return undefined;
    const ctx = this.logic.currentViewport();
    const nextGroup = findNextNonEmptyGroup(
      host,
      selection.groupKey,
      direction,
    );
    if (!nextGroup) return undefined;
    const cellEl = getCellForCellSelection(host, selection);
    if (!cellEl) return undefined;
    const card = findClosestCardByYOffset(
      host,
      cellEl.getBoundingClientRect(),
      nextGroup.group.key,
      ctx,
    );
    if (!card) return undefined;
    // Zelle mit minimalem Y-Abstand in der Ziel-Karte.
    const targetCell = findClosestCellByYOffset(
      card,
      cellEl.getBoundingClientRect(),
      ctx,
    );
    if (!targetCell) return undefined;
    return {
      selectionType: "cell",
      groupKey: nextGroup.group.key,
      cardId: card.cardId,
      columnId: targetCell.column.id,
      isEditing: false,
    };
  }

  private computeNextCardSelection(
    selection: KanbanCardSelection,
    direction: "up" | "down" | "left" | "right",
    topology: KanbanTopology,
  ): KanbanViewSelection | undefined {
    const next = nextCardInDirection(selection, direction, topology);
    if (next) return next;

    if (direction !== "left" && direction !== "right") return undefined;
    const host = this.host;
    if (!host) return undefined;
    const ctx = this.logic.currentViewport();
    const first = selection.cards[0];
    if (!first) return undefined;
    const nextGroup = findNextNonEmptyGroup(host, first.groupKey, direction);
    if (!nextGroup) return undefined;
    // Karte suchen wir via geometrischem Adapter.
    const cardEls = getCardsForCardSelection(host, selection);
    const firstCard = cardEls[0];
    if (!firstCard) return undefined;
    const card = findClosestCardByYOffset(
      host,
      firstCard.getBoundingClientRect(),
      nextGroup.group.key,
      ctx,
    );
    if (!card) return undefined;
    return {
      selectionType: "card",
      cards: [{ groupKey: nextGroup.group.key, cardId: card.cardId }],
    };
  }

  hostConnected() {
    this.host?.disposables.add(
      this.logic.selection$.subscribe((selection) => {
        const old = this._selection;
        if (old) {
          this.blur(old);
        }
        this._selection = selection;
        if (selection) {
          this.focus(selection);
        }
      }),
    );
  }

  insertRowAfter() {
    const selection = this.selection;
    if (selection?.selectionType !== "card") {
      return;
    }

    const { cardId, groupKey } = selection.cards[0];
    const id = this.view.addCard({ before: false, id: cardId }, groupKey);

    requestAnimationFrame(() => {
      const columnId = this.view.mainProperties$.value.titleColumn;
      if (columnId) {
        this.selection = {
          selectionType: "cell",
          groupKey,
          cardId: id,
          columnId,
          isEditing: true,
        };
      } else {
        this.selection = {
          selectionType: "card",
          cards: [
            {
              cardId: id,
              groupKey,
            },
          ],
        };
      }
    });
  }

  insertRowBefore() {
    const selection = this.selection;
    if (selection?.selectionType !== "card") {
      return;
    }

    const { cardId, groupKey } = selection.cards[0];
    const id = this.view.addCard({ before: true, id: cardId }, groupKey);

    requestAnimationFrame(() => {
      const columnId = this.view.mainProperties$.value.titleColumn;
      if (columnId) {
        this.selection = {
          selectionType: "cell",
          groupKey,
          cardId: id,
          columnId,
          isEditing: true,
        };
      } else {
        this.selection = {
          selectionType: "card",
          cards: [
            {
              cardId: id,
              groupKey,
            },
          ],
        };
      }
    });
  }

  moveCard(rowId: string, key: string) {
    const selection = this.selection;
    if (selection?.selectionType !== "card") {
      return;
    }
    const sourceCard =
      selection.cards.find((card) => card.cardId === rowId) ??
      selection.cards[0];
    if (!sourceCard) return;
    this.view.groupTrait.moveCardTo(rowId, sourceCard.groupKey, key, "start");
    requestAnimationFrame(() => {
      if (this.selection?.selectionType !== "card") return;

      const newCards = selection.cards.map((card) => ({
        ...card,
        groupKey: card.cardId === rowId ? key : card.groupKey,
      }));
      // Pure Same-Card-Set (dedupliziert ueber cardId) via Modell.
      const deduped = uniqueById(newCards);
      const cards = nonEmptyCards(deduped);
      this.selection = cards ? { ...selection, cards } : undefined;
    });
  }
}

// =====================================================================
// Lokale Helper (Controller-private; reine Mechanik, keine Algebra)
// =====================================================================

/**
 * Dedup eine Karten-Liste nach `cardId` (Behaelt die erste
 * Reihenfolge). Reine Mechanik, kein Selection-Model.
 */
function uniqueById(
  cards: KanbanCardSelectionCard[],
): KanbanCardSelectionCard[] {
  const seen = new Set<string>();
  const out: KanbanCardSelectionCard[] = [];
  for (const c of cards) {
    if (seen.has(c.cardId)) continue;
    seen.add(c.cardId);
    out.push(c);
  }
  return out;
}

// =====================================================================
// Legacy-Exports (wird von Mobile / Tests gebraucht)
// =====================================================================

export { KanbanCard };
export type { KanbanGroup };
