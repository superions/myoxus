// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `clone-interaction-manager.ts` - P-VIRG-ARCH-G-02.
 *
 * Clone-Teilmanager fuer den GFX-Interactivity-Manager.
 * Aus `interactivity/manager.ts` extrahiert ohne Verhaltensaenderung
 * (pure Delegation). Beheimatet:
 *
 *   - `requestElementClone` (L230-245 in manager.ts)
 *
 * Der Host (`InteractivityManager`) haelt eine Instanz und
 * delegiert die oeffentliche Methode weiterhin, damit externe
 * Konsumenten (z.B. `default-tool.ts:141`) unveraendert
 * funktionieren.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §6.1.1
 *      (P-VIRG-ARCH-G-01 — Verfeinerte Verantwortungs-Kartierung)
 */

import type { GfxModel } from "../model/model.js";
import type {
  ActionContextMap,
  InteractivityActionAPI,
} from "./extension/base.js";
import type { InteractivityManager } from "./manager.js";
import type { RequestElementsCloneContext } from "./types/clone.js";

type CloneResult = ActionContextMap["elementsClone"]["returnType"];

/**
 * Clone-Teilmanager. Erhaelt eine Back-Reference auf den
 * Host (`InteractivityManager`), weil die Clone-Logik auf
 * `interactExtensions` zugreift.
 *
 * **Negativ-Abnahme:** Wenn der Sub-Manager durch no-op-Stubs
 * ersetzt wird, MUSS die E2E-Spec
 * `e2e/edgeless/clone/` rot werden.
 */
export class CloneInteractionManager {
  constructor(private readonly host: InteractivityManager) {}

  /**
   * Vor G-02 `requestElementClone` (L230-245) im
   * `InteractivityManager`. Verhalten unveraendert.
   *
   * Iteriert ueber die registrierten Interactivity-Extensions
   * und emittiert `elementsClone`. Die erste Extension, die ein
   * Clone-Result liefert, gewinnt. Wenn keine Extension
   * antwortet, wird `Promise.resolve(undefined)` zurueckgegeben.
   */
  requestElementClone(
    options: RequestElementsCloneContext,
  ): Promise<{ elements: GfxModel[] } | undefined> {
    const extensions = this.host._interactExtensions;

    for (let ext of extensions.values()) {
      const cloneData = (ext.action as InteractivityActionAPI).emit(
        "elementsClone",
        options,
      ) as CloneResult;

      if (cloneData) {
        return cloneData;
      }
    }

    return Promise.resolve(undefined);
  }
}
