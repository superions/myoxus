// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-selection-dom-adapter.ts` - P-VIRG-ARCH-E-01 + E-02.
 *
 * DOM-Adapter fuer die Kanban-Selection. Kapselt alle `querySelector`
 * und `getBoundingClientRect`-Aufrufe hinter einer schmalen
 * Schnittstelle, die das pure Modell in `kanban-selection-model.ts`
 * mit der gerenderten Lit-Web-Component verbindet.
 *
 * **Pflicht:** Nur dieser Adapter und sein Edgeless-Pendant
 * (`kanban-selection-edgeless-adapter.ts`) duerfen das DOM kennen.
 * Der Selection-Controller delegiert die geometrischen und
 * Mapping-Entscheidungen an diese Schicht; alle algebraischen
 * Operationen leben im Modell.
 *
 * **Schuetzt:**
 *   - Topology-Extraktion aus der gerenderten Board-Struktur.
 *   - Selection -> Element-Lookup (fuer Focus, Scroll, Delete).
 *   - Geometrische Cross-Group-Navigation (Y-Offset-Heuristik).
 *
 * **E-02-Erweiterung:** `findClosestCardByYOffset` und
 * `findClosestCellByYOffset` haben einen optionalen 4./3. Parameter
 * `ctx?: ViewportContext` (siehe `viewport-context.ts`). Mit `ctx`
 * rechnen die Funktionen die CSS-Pixel-Bounds in den
 * Canvas-Koordinatenraum um. Ohne `ctx` ist das Verhalten
 * identisch zu vor E-02 (Page-Modus).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-01 + P-VIRG-ARCH-E-02)
 */

import type { KanbanTopology } from "./kanban-selection-model.js";
import type { KanbanCard } from "./pc/card.js";
import type { KanbanCell } from "./pc/cell.js";
import type { KanbanGroup } from "./pc/group.js";
import type {
  KanbanCardSelection,
  KanbanCellSelection,
  KanbanGroupSelection,
} from "./selection.js";
import type { ViewportContext } from "./viewport-context.js";

/** Selektor-Konstanten. DOM-Wissen liegt NUR hier. */
const SEL_GROUP = "myoxus-data-view-kanban-group";
const SEL_CARD = "myoxus-data-view-kanban-card";
const SEL_CELL = "myoxus-data-view-kanban-cell";

/**
 * Liest die aktuelle Board-Topologie aus dem gerenderten DOM.
 *
 * **Konventionen:**
 *   - Gruppen-Reihenfolge: Document-Order (visuell links-nach-rechts
 *     via CSS-Order im Kanban-Layout; bei Edgeless folgt der
 *     Adapter E-02 einer Canvas-spezifischen Reihenfolge).
 *   - Karten-Reihenfolge pro Gruppe: Document-Order.
 *   - Spalten-Reihenfolge pro Karte: Document-Order.
 */
export function readKanbanTopology(viewElement: Element): KanbanTopology {
  const groups = readGroups(viewElement);
  const groupKeys: string[] = [];
  const groupCards = new Map<string, readonly string[]>();
  const cardColumns = new Map<string, readonly string[]>();
  for (const group of groups) {
    const key = group.group?.key;
    if (!key) continue;
    groupKeys.push(key);
    const cards = readCards(group);
    const cardIds: string[] = [];
    for (const card of cards) {
      const id = card.cardId;
      if (!id) continue;
      cardIds.push(id);
      const columns = readColumns(card);
      const colIds: string[] = [];
      for (const col of columns) {
        const cid = col.column.id;
        if (cid) colIds.push(cid);
      }
      cardColumns.set(id, colIds);
    }
    groupCards.set(key, cardIds);
  }
  return { groupKeys, groupCards, cardColumns };
}

function readGroups(viewElement: Element): KanbanGroup[] {
  return Array.from(viewElement.querySelectorAll<KanbanGroup>(SEL_GROUP));
}

function readCards(group: KanbanGroup): KanbanCard[] {
  return Array.from(group.querySelectorAll<KanbanCard>(SEL_CARD));
}

function readColumns(card: KanbanCard): KanbanCell[] {
  return Array.from(card.querySelectorAll<KanbanCell>(SEL_CELL));
}

// =====================================================================
// Selection -> Element Lookup
// =====================================================================

/** Liefert die Karte zu einer Cell-Selection, oder `null`. */
export function getCardForCellSelection(
  viewElement: Element,
  selection: KanbanCellSelection,
): KanbanCard | null {
  const group = viewElement.querySelector<HTMLElement>(
    `${SEL_GROUP}[data-key="${cssEscape(selection.groupKey)}"]`,
  );
  if (!group) return null;
  return group.querySelector<KanbanCard>(
    `${SEL_CARD}[data-card-id="${cssEscape(selection.cardId)}"]`,
  );
}

/** Liefert die Cell-Element zu einer Cell-Selection, oder `null`. */
export function getCellForCellSelection(
  viewElement: Element,
  selection: KanbanCellSelection,
): KanbanCell | null {
  const card = getCardForCellSelection(viewElement, selection);
  if (!card) return null;
  return card.querySelector<KanbanCell>(
    `${SEL_CELL}[data-column-id="${cssEscape(selection.columnId)}"]`,
  );
}

/** Liefert die Karten-Elemente zu einer Card- oder Group-Selection. */
export function getCardsForCardSelection(
  viewElement: Element,
  selection: KanbanCardSelection | KanbanGroupSelection,
): KanbanCard[] {
  if (selection.selectionType === "group") return [];
  // Dedup groupKeys: bei mehreren selektierten Karten in derselben
  // Gruppe darf die Gruppe nicht mehrfach abgefragt werden, sonst
  // entstehen Phantom-Duplikate (E-01-Fix).
  const groupKeys = Array.from(new Set(selection.cards.map((c) => c.groupKey)));
  const groups = groupKeys
    .map((key) =>
      viewElement.querySelector<HTMLElement>(
        `${SEL_GROUP}[data-key="${cssEscape(key)}"]`,
      ),
    )
    .filter((g): g is HTMLElement => g !== null);
  const cardIds = selection.cards.map((c) => c.cardId);
  return groups
    .flatMap((group) =>
      cardIds.map((id) =>
        group.querySelector<KanbanCard>(
          `${SEL_CARD}[data-card-id="${cssEscape(id)}"]`,
        ),
      ),
    )
    .filter((c): c is KanbanCard => c !== null);
}

// =====================================================================
// Geometry: Cross-Group-Navigation
// =====================================================================

/**
 * Liefert die Karte in `nextGroupKey`, deren Bounding-Box-Mitte
 * den kleinsten Y-Abstand zur aktuellen Selektion hat.
 *
 * **Verhalten:** Folgt der bisherigen Heuristik in
 * `controller/selection.ts`: der aktuelle Fokus-Rechteck wird mit
 * den Karten der Zielgruppe verglichen, die mit minimalem vertikalen
 * Versatz gewaehlt wird.
 *
 * **Edgeless-Skalierung (P-VIRG-ARCH-E-02):** Wenn `ctx.scale != 1`
 * uebergeben wird, werden sowohl `currentRect` als auch die intern
 * gelesenen Card-Rects durch `ctx.scale` dividiert, BEVOR der
 * Y-Offset-Vergleich laeuft. Damit landet der Vergleich im
 * Canvas-Koordinatenraum (siehe
 * `note-edgeless-block.ts:103` als Vorbild).
 *
 * **Rueckwaertskompatibel:** Ohne `ctx` (Page-Modus) wird das
 * alte CSS-Pixel-Verhalten reproduziert. Bestehende 17 Tests
 * bleiben unveraendert gruen.
 */
export function findClosestCardByYOffset(
  viewElement: Element,
  currentRect: DOMRect,
  nextGroupKey: string,
  ctx?: ViewportContext,
): KanbanCard | null {
  const group = viewElement.querySelector<KanbanGroup>(
    `${SEL_GROUP}[data-key="${cssEscape(nextGroupKey)}"]`,
  );
  if (!group) return null;
  const nextCards = Array.from(group.querySelectorAll<KanbanCard>(SEL_CARD));
  if (nextCards.length === 0) return null;
  // Edgeless-Pfad: currentRect UND Card-Rects in Canvas-Koords
  // umrechnen. Page-Pfad: ctx undefined -> scale = 1 -> identische
  // Mathematik wie vor E-02.
  const scale = ctx?.scale ?? 1;
  const refRect = scale === 1 ? currentRect : scaleRect(currentRect, 1 / scale);
  let bestCard: KanbanCard | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (const card of nextCards) {
    const r = card.getBoundingClientRect();
    const cardRect = scale === 1 ? r : scaleRect(r, 1 / scale);
    const offset = yOffset(refRect, cardRect);
    if (offset < bestOffset) {
      bestOffset = offset;
      bestCard = card;
    }
  }
  return bestCard;
}

/** Liefert die naechste (oder vorherige) Gruppe, die nicht leer ist. */
export function findNextNonEmptyGroup(
  viewElement: Element,
  fromGroupKey: string,
  direction: "left" | "right",
): KanbanGroup | null {
  const groups = readGroups(viewElement);
  const groupIndex = groups.findIndex((g) => g.group.key === fromGroupKey);
  if (groupIndex < 0) return null;
  let i =
    direction === "right"
      ? groupIndex === groups.length - 1
        ? 0
        : groupIndex + 1
      : groupIndex === 0
        ? groups.length - 1
        : groupIndex - 1;
  let next = groups[i] ?? null;
  while (next && next.group.rows.length === 0) {
    i =
      direction === "right"
        ? i === groups.length - 1
          ? 0
          : i + 1
        : i === 0
          ? groups.length - 1
          : i - 1;
    next = groups[i] ?? null;
  }
  return next;
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Liefert die Cell-Element einer Karte mit minimalem Y-Abstand zu
 * `refRect`. Geometrie-Adapter, weil die Spaltenreihenfolge von der
 * visuellen Y-Position abhaengt.
 *
 * **Edgeless-Skalierung (P-VIRG-ARCH-E-02):** Symmetrisch zu
 * `findClosestCardByYOffset`. Wenn `ctx.scale != 1`, werden beide
 * Seiten des Y-Offset-Vergleichs in den Canvas-Koordinatenraum
 * umgerechnet.
 */
export function findClosestCellByYOffset(
  card: KanbanCard,
  refRect: DOMRect,
  ctx?: ViewportContext,
): KanbanCell | null {
  const cells = Array.from(card.querySelectorAll<KanbanCell>(SEL_CELL));
  if (cells.length === 0) return null;
  const scale = ctx?.scale ?? 1;
  const ref = scale === 1 ? refRect : scaleRect(refRect, 1 / scale);
  let best: KanbanCell | null = null;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (const c of cells) {
    const r = c.getBoundingClientRect();
    const cellRect = scale === 1 ? r : scaleRect(r, 1 / scale);
    const offset = yOffset(ref, cellRect);
    if (offset < bestOffset) {
      bestOffset = offset;
      best = c;
    }
  }
  return best;
}

/** Y-Offset zwischen zwei Bounding-Box-Mitten. */
function yOffset(a: DOMRect, b: DOMRect): number {
  return Math.abs(
    a.top + (a.bottom - a.top) / 2 - (b.top + (b.bottom - b.top) / 2),
  );
}

/**
 * Skaliert ein `DOMRect` um den Faktor `factor`. `factor = 1` ist
 * Identity. Reine Inline-Implementierung fuer die Edgeless-Pfade
 * in `findClosestCardByYOffset` / `findClosestCellByYOffset` -
 * NICHT exportiert, weil sie nur ein Implementierungsdetail der
 * Skalierungs-Pfade ist. Public-API-Skalierung lebt in
 * `kanban-selection-edgeless-adapter.ts:domRectToCanvas`.
 */
function scaleRect(rect: DOMRect, factor: number): DOMRect {
  return {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
    top: rect.top * factor,
    right: rect.right * factor,
    bottom: rect.bottom * factor,
    left: rect.left * factor,
    toJSON: rect.toJSON.bind(rect),
  } as DOMRect;
}

/**
 * Minimales CSS-Escaping fuer Attribut-Selektoren. Ausreichend fuer
 * `data-key` und `data-card-id`, die aktuell nur `[a-z0-9-]+` enthalten.
 * Schieberegler wie `:`, `.` oder Quotes werden mit `\\` escaped; die
 * vollstaendige Spec-Implementierung (z.B. via `CSS.escape`) ist
 * Folgejob in H-XX.
 */
function cssEscape(value: string): string {
  return value.replace(/([\\":.[\]#%])/g, "\\$1");
}
