// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `viewport-context.ts` - P-VIRG-ARCH-E-02.
 *
 * Abstrakte Beschreibung der "Sicht"-Geometrie, in der eine
 * Kanban-Board gerendert wird. Wird vom DOM-Adapter konsumiert,
 * damit Cross-Group-Selection (Y-Offset) und DnD-Drop-Indikatoren
 * im Edgeless-Modus mit der Canvas-Skala rechnen.
 *
 * **Lebenszyklus:**
 *   - Wird im Page-Modus auf `{ scale: 1 }` (Default) gesetzt.
 *   - Wird im Edgeless-Modus vom `database-block` ueber die
 *     `DataViewRendererConfig.viewportProvider$` injiziert. Der
 *     Provider liest `this.gfx.viewport.zoom` (siehe
 *     `note-edgeless-block.ts:101, 239, 352` als Vorbild).
 *   - Wird in `KanbanViewUILogic.currentViewport()` zu einer
 *     reinen `ViewportContext` materialisiert.
 *
 * **Warum ein eigener Typ:**
 *   - DOM-Adapter (`kanban-selection-dom-adapter.ts`) hat keinen
 *     Lit-/Block-Import. Die Schnittstelle muss ein plain data-
 *     Objekt sein, kein BlockHandle.
 *   - `toCanvasCoord` ist optional, weil die meisten Pfade
 *     (Y-Offset-Vergleich, Drop-Indikator) Translation-invariant
 *     sind. Wenn Pan-Offset ins Spiel kommt (E-FIND-06), wird
 *     `viewport.toViewCoordFromClientCoord` durchgereicht.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §E
 *      (P-VIRG-ARCH-E-02)
 */

export interface ViewportContext {
  /**
   * CSS-px -> Canvas-px Skalierungsfaktor.
   *
   * Page-Modus: `1` (kein Skalierungsunterschied).
   * Edgeless-Modus: typisch `0.5`..`2.0`, gelesen aus
   * `gfx.viewport.zoom` (siehe `note-edgeless-block.ts:101, 352`).
   */
  readonly scale: number;

  /**
   * Optionaler Client-Punkt -> Canvas-Punkt. Default: identische
   * Translation. Wird gesetzt, sobald ein Block echte
   * `viewport.toViewCoordFromClientCoord` einbringt
   * (siehe `blocks/attachment/src/attachment-service.ts:32`).
   *
   * Aktuell ungenutzt (E-02) - Reserve fuer E-FIND-06.
   */
  toCanvasCoord?(clientX: number, clientY: number): { x: number; y: number };
}

/**
 * Page-Default-Viewport. Wird von `currentViewport()` zurueckgegeben,
 * wenn der `viewportProvider$` nicht gesetzt ist (Page-Modus).
 */
export const PAGE_VIEWPORT: ViewportContext = Object.freeze({
  scale: 1,
});
