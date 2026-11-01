// SPDX-License-Identifier: MIT

/**
 * `selection-interaction-manager.ts` - P-VIRG-ARCH-G-02.
 *
 * Selection-Teilmanager fuer den GFX-Interactivity-Manager.
 * Aus `interactivity/manager.ts` extrahiert ohne Verhaltensaenderung
 * (pure Delegation). Beheimatet:
 *
 *   - `_getSelectionConfig` (L142-200 in manager.ts)
 *   - `_getSuggestedTarget` (L202-246)
 *   - `handleElementSelection` (L253-323)
 *   - `handleBoxSelection` (L325-346)
 *
 * Der Host (`InteractivityManager`) haelt eine Instanz und
 * delegiert die oeffentlichen Methoden weiterhin, damit externe
 * Konsumenten (z.B. `default-tool.ts:98, 161, 214`) unveraendert
 * funktionieren.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §6.1.1
 *      (P-VIRG-ARCH-G-01 — Verfeinerte Verantwortungs-Kartierung)
 */

import { Point } from "@virgultum/global/gfx";
import last from "lodash-es/last.js";

import type { PointerEventState } from "../../event/state/pointer.js";
import { getTopElements } from "../../utils/tree.js";
import type { GfxBlockComponent } from "../../view/index.js";
import { GfxBlockElementModel } from "../model/gfx-block-model.js";
import type { GfxModel } from "../model/model.js";
import { GfxPrimitiveElementModel } from "../model/surface/element-model.js";
import type { GfxElementModelView } from "../view/view.js";
import type { InteractivityActionAPI } from "./extension/base.js";
import type {
  GfxViewInteractionConfig,
  GfxViewInteractionIdentifier as GfxViewInteractionIdentifierType,
} from "./extension/view.js";
import { GfxViewInteractionIdentifier } from "./extension/view.js";
import type { InteractivityManager } from "./manager.js";
import type { BoxSelectionContext, SelectContext } from "./types/view.js";

type SelectionHandlers = Required<
  ReturnType<Required<GfxViewInteractionConfig>["handleSelection"]>
>;

interface SelectionConfigEntry {
  view: GfxBlockComponent | GfxElementModelView;
  handlers: SelectionHandlers;
  defaultHandlers: SelectionHandlers;
}

/**
 * Selection-Teilmanager. Erhaelt eine Back-Reference auf den
 * Host (`InteractivityManager`), weil die Selection-Logik auf
 * `gfx`, `std`, `interactExtensions` und die gemeinsamen
 * Utilities (`_safeExecute` etc.) des Hosts zugreift.
 *
 * **Negativ-Abnahme:** Wenn der Sub-Manager durch no-op-Stubs
 * ersetzt wird, MUSS die E2E-Spec
 * `e2e/edgeless/selection/` rot werden.
 */
export class SelectionInteractionManager {
  constructor(private readonly host: InteractivityManager) {}

  /**
   * Pure Delegation zu `gfx.view.get(model)` + Aufloesung der
   * `GfxViewInteractionConfig`. Vor G-02 private Methode
   * `_getSelectionConfig` (L142-200).
   */
  getSelectionConfig(models: GfxModel[]): Map<string, SelectionConfigEntry> {
    const selectionConfigMap = new Map<string, SelectionConfigEntry>();

    models.forEach((model) => {
      const typeOrFlavour = "flavour" in model ? model.flavour : model.type;
      const view = this.host._gfx.view.get(model);
      const config = this.host._std.getOptional(
        GfxViewInteractionIdentifier(
          typeOrFlavour as Parameters<
            typeof GfxViewInteractionIdentifierType
          >[0],
        ),
      );

      if (!view) {
        return;
      }

      const selectionConfig =
        config?.handleSelection?.({
          gfx: this.host._gfx,
          std: this.host._std,
          view,
          model,
        }) ?? {};
      const defaultHandlers = {
        selectable: () => {
          return !model.isLockedByAncestor();
        },
        onSelect: (context: SelectContext) => {
          if (context.multiSelect) {
            this.host._gfx.selection.toggle(model);
          } else {
            this.host._gfx.selection.set({ elements: [model.id] });
          }

          return true;
        },
      };

      selectionConfigMap.set(model.id, {
        view,
        defaultHandlers,
        handlers: {
          ...defaultHandlers,
          ...selectionConfig,
        },
      });
    });

    return selectionConfigMap;
  }

  /**
   * Pure Delegation der `interactExtensions`-Suggestion. Vor
   * G-02 private Methode `_getSuggestedTarget` (L202-246).
   */
  getSuggestedTarget(context: {
    candidates: GfxModel[];
    target: GfxModel;
  }): GfxModel {
    const { candidates, target } = context;

    const suggestedElements: {
      id: string;
      priority?: number;
    }[] = [];
    const suggest = (element: { id: string; priority?: number }) => {
      suggestedElements.push(element);
    };

    const extensions = this.host._interactExtensions;
    extensions
      .values()
      .toArray()
      .forEach((ext) => {
        return (ext.action as InteractivityActionAPI).emit("elementSelect", {
          candidates,
          target,
          suggest,
        });
      });

    if (suggestedElements.length) {
      suggestedElements.sort((a, b) => {
        return (a.priority ?? 0) - (b.priority ?? 0);
      });

      const suggested = suggestedElements[suggestedElements.length - 1] as {
        id: string;
        priority?: number;
      };
      const elm = this.host._gfx.getElementById(suggested.id);

      return elm instanceof GfxPrimitiveElementModel ||
        elm instanceof GfxBlockElementModel
        ? elm
        : target;
    }

    return target;
  }

  /**
   * Vor G-02 `handleElementSelection` (L253-323) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  handleElementSelection(evt: PointerEventState): boolean {
    const { raw } = evt;
    const gfx = this.host._gfx;
    const [x, y] = gfx.viewport.toModelCoordFromClientCoord([raw.x, raw.y]);
    let candidates = gfx.getElementByPoint(x, y, {
      all: true,
    });

    const selectionConfigs = this.getSelectionConfig(candidates);
    const context = {
      multiSelect: raw.shiftKey,
      event: raw,
      position: Point.from([x, y]),
    };

    candidates = candidates.filter((model) => {
      if (!selectionConfigs.has(model.id)) {
        return false;
      }
      const config = selectionConfigs.get(model.id)!;

      return (
        selectionConfigs.has(model.id) &&
        selectionConfigs.get(model.id)?.handlers.selectable({
          ...context,
          view: config.view,
          model,
          default: config.defaultHandlers.selectable as () => boolean,
        })
      );
    });

    {
      let target = last(candidates);

      if (!target) {
        return false;
      }

      target = this.getSuggestedTarget({
        candidates,
        target,
      });

      const config = selectionConfigs.has(target.id)
        ? selectionConfigs.get(target.id)
        : this.getSelectionConfig([target]).get(target.id);

      if (!config) {
        return false;
      }

      const multiSelect = raw.shiftKey;
      const onSelectContext = {
        selected: multiSelect ? !gfx.selection.has(target.id) : true,
        multiSelect,
        event: raw,
        position: Point.from([x, y]),
      };

      const result = config.handlers.onSelect({
        ...onSelectContext,
        selected: multiSelect ? !gfx.selection.has(target.id) : true,
        view: config.view,
        model: target,
        default: config.defaultHandlers.onSelect as () => void,
      });

      return result ?? true;
    }
  }

  /**
   * Vor G-02 `handleBoxSelection` (L325-343). Verhalten
   * unveraendert. Liefert die Box-Selektion-Kandidatenliste
   * (Top-Elemente, nicht-gesperrt) — der aufrufende Code in
   * `default-tool.ts` macht daraus die `selection.set(...)`-Aktion.
   */
  handleBoxSelection(context: { box: BoxSelectionContext["box"] }): GfxModel[] {
    const elements = this.host._gfx
      .getElementsByBound(context.box)
      .filter((model) => {
        const view = this.host._gfx.view.get(model);

        if (
          !view ||
          view.onBoxSelected({
            box: context.box,
          }) === false
        )
          return false;

        return true;
      });

    return getTopElements(elements).filter((elm) => !elm.isLocked());
  }
}
