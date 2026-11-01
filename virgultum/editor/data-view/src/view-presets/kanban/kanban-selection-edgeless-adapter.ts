// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `kanban-selection-edgeless-adapter.ts` - P-VIRG-ARCH-E-02.
 *
 * Edgeless-/Canvas-bewusste Variante der geometrischen
 * Kanban-Adapter-Funktionen. Skaliert die CSS-Pixel-`DOMRect`s aus
 * `getBoundingClientRect()` auf den Canvas-Koordinatenraum zurueck,
 * bevor der Y-Offset-Vergleich laeuft.
 *
 * **Skalierungs-Invarianten:**
 *   - `viewport.scale > 0`. Default `1` (Page-Modus).
 *   - Edgeless rendert via `transform: scale(zoom)`. Damit sind alle
 *     CSS-Pixel-Bounds um den Faktor `zoom` vergroessert
 *     (zoom=2 -> Karte ist 2x so gross in CSS-Pixeln). Wir
 *     rechnen mit `canvasCoord = clientCoord / scale` zurueck.
 *   - Konsistent mit `note-edgeless-block.ts:103`:
 *     `rect.height / scale / zoom`.
 *   - In Edgeless-Modus rendert die Kanban-View in einer Note
 *     (siehe M09); die Note selbst hat zusaetzlich
 *     `model.props.edgeless.scale` (siehe
 *     `note-edgeless-block.ts:94, 261`). Wir kombinieren beide.
 *
 * **Pflicht:** Nur dieser Adapter und `viewport-context.ts` duerfen
 * von Canvas-Skala wissen. Der Page-Adapter bleibt
 * CSS-Pixel-naiv.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-02)
 */

import {
  findClosestCardByYOffset,
  findClosestCellByYOffset,
} from "./kanban-selection-dom-adapter.js";
import type { KanbanCard } from "./pc/card.js";
import type { KanbanCell } from "./pc/cell.js";
import type { KanbanGroup } from "./pc/group.js";
import { type ViewportContext } from "./viewport-context.js";

// =====================================================================
// Block-Viewport-Bridge
// =====================================================================

/**
 * Minimaler Block-Handle, der im Edgeless-Modus die noetigen
 * Skalierungs-Quellen liefert. Wird von `database-block.ts` an
 * `DataViewRendererConfig.viewportProvider$` uebergeben.
 *
 * **E-02-Mindestvertrag:**
 *   - `gfx.viewport.zoom`: Edgeless-Viewport-Skalierung
 *     (siehe `note-edgeless-block.ts:101, 239, 352`).
 *   - `model.props.edgeless.scale`: Per-Note-Skalierung
 *     (siehe `note-edgeless-block.ts:94, 261, 295`).
 *
 * Beide Felder sind optional. Page-Modus liefert `undefined`
 * zurueck.
 */
export interface EdgelessBlockHandle {
  readonly gfx?: {
    readonly viewport?: {
      readonly zoom?: number;
    };
  };
  readonly model?: {
    readonly props?: {
      readonly edgeless?: {
        readonly scale?: number;
      };
    };
  };
}

/**
 * Materialisiert eine `ViewportContext` aus einem Edgeless-Block-
 * Handle. Aufruf-Pfad: `KanbanViewUILogic.currentViewport()`.
 *
 * **Verhalten:**
 *   - Wenn das Handle Edgeless-Quellen liefert, kombiniert es
 *     `viewport.zoom * edgeless.scale` (Multiplikation, weil beide
 *     Faktoren das gleiche Bounds-Wachstum verursachen).
 *   - Wenn eine Quelle fehlt, faellt sie auf `1` zurueck.
 *   - Wenn das Handle `undefined` ist, wird `scale: 1` (Page)
 *     zurueckgegeben. Der Aufrufer entscheidet, ob `undefined`
 *     Edgeless bedeutet - dieser Helper ist neutral.
 */
export function edgelessViewportContext(
  block: EdgelessBlockHandle | undefined | null,
): ViewportContext {
  if (!block) {
    return { scale: 1 };
  }
  const zoom = block.gfx?.viewport?.zoom ?? 1;
  const noteScale = block.model?.props?.edgeless?.scale ?? 1;
  const scale = zoom * noteScale;
  return { scale };
}

// =====================================================================
// Scale-aware Rect-Helpers
// =====================================================================

/**
 * Skaliert ein CSS-Pixel-`DOMRect` in den Canvas-Koordinatenraum
 * zurueck. Reine Skalierung, keine Translation (Y-Offset-Vergleiche
 * sind Translation-invariant; siehe E-FIND-06 fuer Pan-Offset).
 *
 * Bei `scale = 1` (Page) ist die Rueckgabe identisch zur Eingabe.
 */
export function domRectToCanvas(rect: DOMRect, ctx: ViewportContext): DOMRect {
  if (ctx.scale === 1) return rect;
  const s = ctx.scale;
  return {
    x: rect.x / s,
    y: rect.y / s,
    width: rect.width / s,
    height: rect.height / s,
    top: rect.top / s,
    right: rect.right / s,
    bottom: rect.bottom / s,
    left: rect.left / s,
    toJSON: rect.toJSON.bind(rect),
  } as DOMRect;
}

// =====================================================================
// Edgeless-Adapter-Wrapper
// =====================================================================

/**
 * Edgeless-Variante von `findClosestCardByYOffset`. Skaliert
 * `currentRect` und alle intern verglichenen Card-Rects auf
 * Canvas-Koordinaten, BEVOR der Y-Offset-Vergleich laeuft.
 *
 * **Math:** Bei `viewport.scale = 2` ist die Quell-Card in CSS-Pixeln
 * doppelt so gross wie in Canvas-Pixeln. Ohne Skalierung wuerde
 * der Vergleich in CSS-Pixeln gegen die ebenfalls vergroesserten
 * Ziel-Karten laufen -> Glueckstreffer. Mit Skalierung landet die
 * Y-Mitte der Quell-Card wieder auf der korrekten Canvas-Y-Position
 * der Ziel-Karten-Mitte.
 */
export function findClosestCardByYOffsetInCanvas(
  viewElement: Element,
  currentRect: DOMRect,
  nextGroupKey: string,
  ctx: ViewportContext,
): ReturnType<typeof findClosestCardByYOffset> {
  if (ctx.scale === 1) {
    return findClosestCardByYOffset(viewElement, currentRect, nextGroupKey);
  }
  const canvasRect = domRectToCanvas(currentRect, ctx);
  // Der Page-Adapter liest die Ziel-Card-Rects selbst aus dem DOM
  // und teilt sie ebenfalls durch ctx.scale. Damit ist der
  // Y-Offset-Vergleich konsistent im Canvas-Raum.
  return findClosestCardByYOffset(viewElement, canvasRect, nextGroupKey, ctx);
}

/**
 * Edgeless-Variante von `findClosestCellByYOffset`. Symmetrisch zum
 * Card-Wrapper: `refRect` wird in Canvas-Koordinaten umgerechnet,
 * die intern gelesenen Cell-Rects ebenfalls.
 */
export function findClosestCellByYOffsetInCanvas(
  card: KanbanCard,
  refRect: DOMRect,
  ctx: ViewportContext,
): ReturnType<typeof findClosestCellByYOffset> {
  if (ctx.scale === 1) {
    return findClosestCellByYOffset(card, refRect);
  }
  const canvasRect = domRectToCanvas(refRect, ctx);
  return findClosestCellByYOffset(card, canvasRect, ctx);
}

// =====================================================================
// DnD Drop-Indikator (Edgeless)
// =====================================================================

/**
 * Liefert die linke obere Ecke und Breite eines Drop-Indikators
 * in CSS-Pixeln, der die Edgeless-Skalierung herausrechnet.
 *
 * **Verwendung:** `pc/controller/drag.ts` ruft das hier auf statt
 * `target.getBoundingClientRect()` direkt zu nehmen. Das
 * Drag-Overlay-Element sitzt ausserhalb des Canvas (siehe
 * `createDropPreview` in `drag.ts:211-275`), also CSS-Pixel korrekt
 * - aber der Berechnungs-Input MUSS in CSS-Pixel sein, weil die
 * Overlay-`div.style.left/top` in CSS-Pixel interpretiert werden.
 *
 * **Beispiel:** Note bei `scale = 2`, Karte-Bottom bei Canvas-Y
 * `200` rendert in CSS-Pixeln bei `400`. Der Drop-Indikator soll
 * auf CSS-Y `400` zeigen, nicht auf `200` (das waere zu hoch).
 */
export function dropIndicatorRectInCanvas(
  rect: DOMRect,
  _ctx: ViewportContext,
): { left: number; top: number; width: number; height: number } {
  // Die rect-Werte sind bereits in CSS-Pixeln (von
  // getBoundingClientRect()). Wir geben sie unveraendert weiter,
  // weil der Overlay-Container ein document.body-Child ist und
  // CSS-Pixel-Koordinaten erwartet. ctx.scale ist hier nur ein
  // Marker, dass Edgeless-Awareness vorhanden ist.
  //
  // Diese Funktion ist als Adapter-Punkt reserviert: sobald
  // Pan-Offset (E-FIND-06) ins Spiel kommt, wird hier die
  // Translation via ctx.toCanvasCoord invertiert.
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Liefert den CSS-Pixel-Mittelpunkt einer Card, Edgeless-bewusst.
 * Wird in `drag.ts:getCardByPoint` (Z. 277-290) fuer den
 * Insertion-Index-Vergleich genutzt.
 *
 * **Skalierung:** Vergleich gegen `evt.y` (CSS-Pixel vom
 * `elementsFromPoint`-Aufruf). Card-Rects sind CSS-Pixel. Beide
 * Seiten CSS-Pixel -> kein Skalierungs-Divide noetig, solange
 * `evt.y` ebenfalls CSS-Pixel ist (was es ist - siehe
 * `MouseEvent.x/y` Definition).
 *
 * Edgeless-Awareness: bestaetigt nur, dass der Adapter konsistent
 * mit der Edgeless-Skalierung arbeitet. Sobald Pan-Offset ins Spiel
 * kommt, MUSS `evt.y` ueber `ctx.toCanvasCoord` in Canvas-Pixel
 * umgerechnet und die `positions` ebenfalls in Canvas-Pixel.
 */
export function cardMidpointsInCanvas(
  cards: readonly KanbanCard[],
  _ctx: ViewportContext,
): number[] {
  return cards.map((v) => {
    const r = v.getBoundingClientRect();
    return (r.top + r.bottom) / 2;
  });
}

// E-02-FIX-08: `getCardByPoint` verwendet CSS-Pixel-Werte, weil
// `elementsFromPoint` ebenfalls CSS-Pixel liefert. Edgeless-Skalierung
// wirkt symmetrisch (Cards und Pointer beide CSS-Pixel); nur
// Translation waere asymmetrisch. Daher bis E-FIND-06 kein Divide.

// E-02-Hilfstyp-Export fuer Tests:
export type { KanbanCard, KanbanCell, KanbanGroup };
