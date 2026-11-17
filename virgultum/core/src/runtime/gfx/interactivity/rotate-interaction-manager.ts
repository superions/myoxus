// SPDX-License-Identifier: MIT

/**
 * `rotate-interaction-manager.ts` - P-VIRG-ARCH-G-02.
 *
 * Rotate-Teilmanager fuer den GFX-Interactivity-Manager.
 * Aus `interactivity/manager.ts` extrahiert ohne Verhaltensaenderung
 * (pure Delegation). Beheimatet:
 *
 *   - `handleElementRotate` (L193-300 in manager.ts)
 *   - `_getViewRotateConfig` (L302-438)
 *   - `getRotateConfig` (L462-464)
 *
 * Der Host (`InteractivityManager`) haelt eine Instanz und
 * delegiert die oeffentlichen Methoden weiterhin, damit externe
 * Konsumenten (z.B. `default-tool.ts:140 ff.`) unveraendert
 * funktionieren.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §6.1.1
 *      (P-VIRG-ARCH-G-01 — Verfeinerte Verantwortungs-Kartierung)
 */

import type { GfxBlockComponent } from "../../view/index.js";
import { GfxBlockElementModel } from "../model/gfx-block-model.js";
import type { GfxModel } from "../model/model.js";
import type { GfxElementModelView } from "../view/view.js";
import { type InteractivityActionAPI } from "./extension/base.js";
import type { GfxViewInteractionConfig } from "./extension/view.js";
import { GfxViewInteractionIdentifier } from "./extension/view.js";
import type { InteractivityManager } from "./manager.js";
import { ResizeController, type RotateOption } from "./resize/manager.js";
import type { RotateConstraint } from "./types/view.js";

export interface RotateConfigResult {
  initialRotate: number;
  rotatable: boolean;
  viewConfigMap: Map<
    string,
    {
      model: GfxModel;
      view: GfxElementModelView | GfxBlockComponent;
      handlers: Required<
        ReturnType<Required<GfxViewInteractionConfig>["handleRotate"]>
      >;
      defaultHandlers: Required<
        ReturnType<Required<GfxViewInteractionConfig>["handleRotate"]>
      >;
      constraint: Required<RotateConstraint>;
    }
  >;
}

/**
 * Rotate-Teilmanager. Erhaelt eine Back-Reference auf den
 * Host (`InteractivityManager`), weil die Rotate-Logik auf
 * `gfx`, `std`, `interactExtensions`, `activeInteraction$` und
 * den geteilten `ResizeController` zugreift.
 *
 * **Negativ-Abnahme:** Wenn der Sub-Manager durch no-op-Stubs
 * ersetzt wird, MUSS die E2E-Spec
 * `e2e/edgeless/rotate/` rot werden.
 */
export class RotateInteractionManager {
  constructor(private readonly host: InteractivityManager) {}

  /**
   * Vor G-02 `_getViewRotateConfig` (L302-438) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  private _getViewRotateConfig(elements: GfxModel[]): RotateConfigResult {
    const context = { elements: [...elements], operation: "rotate" as const };
    for (const extension of this.host._interactExtensions.values()) {
      (extension.action as InteractivityActionAPI).emit(
        "transformElements",
        context,
      );
    }
    const deleted = new Set<GfxModel>();
    const added = new Set<GfxModel>();
    const del = (model: GfxModel) => {
      deleted.add(model);
    };
    const add = (model: GfxModel) => {
      added.add(model);
    };

    type ViewRotateHandlers = Required<
      ReturnType<Required<GfxViewInteractionConfig>["handleRotate"]>
    >;

    const viewConfigMap = new Map<
      string,
      {
        model: GfxModel;
        view: GfxElementModelView | GfxBlockComponent;
        handlers: ViewRotateHandlers;
        defaultHandlers: ViewRotateHandlers;
        constraint: Required<RotateConstraint>;
      }
    >();

    const addToConfigMap = (model: GfxModel) => {
      const flavourOrType = "type" in model ? model.type : model.flavour;
      const interactionConfig = this.host._std.getOptional(
        GfxViewInteractionIdentifier(flavourOrType),
      );
      const view = this.host._gfx.view.get(model);

      if (!view) {
        return;
      }

      const defaultHandlers: ViewRotateHandlers = {
        beforeRotate: () => {},
        onRotateStart: (context) => {
          if (!context.constraint.rotatable) {
            return;
          }

          if (model instanceof GfxBlockElementModel) {
            if (Object.hasOwn(model.props, "rotate")) {
              // @ts-expect-error prop existence has been checked
              model.stash("rotate");
              model.stash("xywh");
            }
          } else {
            model.stash("rotate");
            model.stash("xywh");
          }
        },
        onRotateEnd: (context) => {
          if (!context.constraint.rotatable) {
            return;
          }

          if (model instanceof GfxBlockElementModel) {
            if (Object.hasOwn(model.props, "rotate")) {
              // @ts-expect-error prop existence has been checked
              model.pop("rotate");
              model.pop("xywh");
            }
          } else {
            model.pop("rotate");
            model.pop("xywh");
          }
        },
        onRotateMove: (context) => {
          if (!context.constraint.rotatable) {
            return;
          }

          const { newBound, newRotate } = context;
          model.rotate = newRotate;
          model.xywh = newBound.serialize();
        },
      };
      const handlers = interactionConfig?.handleRotate?.({
        std: this.host._std,
        gfx: this.host._gfx,
        view,
        model,
        delete: del,
        add,
      });

      viewConfigMap.set(model.id, {
        model,
        view,
        defaultHandlers,
        handlers: Object.assign({}, defaultHandlers, handlers ?? {}),
        constraint: {
          rotatable: true,
        },
      });
    };

    context.elements.forEach(addToConfigMap);

    deleted.forEach((model) => {
      if (viewConfigMap.has(model.id)) {
        viewConfigMap.delete(model.id);
      }
    });

    added.forEach((model) => {
      if (viewConfigMap.has(model.id)) {
        return;
      }

      addToConfigMap(model);
    });

    const views = Array.from(viewConfigMap.values().map((item) => item.view));

    let rotatable = viewConfigMap.size > 0;
    viewConfigMap.forEach((config) => {
      const handlers = config.handlers;

      handlers.beforeRotate({
        set: (newConstraint: RotateConstraint) => {
          Object.assign(config.constraint, newConstraint);
          rotatable = rotatable && config.constraint.rotatable;
        },
        elements: views,
      });
    });

    return {
      initialRotate: views.length > 1 ? 0 : (views[0]?.model.rotate ?? 0),
      rotatable,
      viewConfigMap,
    };
  }

  /**
   * Vor G-02 `getRotateConfig` (L462-464) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  getRotateConfig(options: { elements: GfxModel[] }): RotateConfigResult {
    return this._getViewRotateConfig(options.elements);
  }

  /**
   * Vor G-02 `handleElementRotate` (L193-300) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  handleElementRotate(
    options: Omit<
      RotateOption,
      "onRotateStart" | "onRotateEnd" | "onRotateUpdate"
    > & {
      onRotateUpdate?: (payload: {
        currentAngle: number;
        delta: number;
      }) => void;
      onRotateStart?: () => void;
      onRotateEnd?: () => void;
    },
  ): void {
    const { rotatable, viewConfigMap, initialRotate } =
      this._getViewRotateConfig(options.elements);

    if (!rotatable) {
      return;
    }

    const handler = new ResizeController({ gfx: this.host._gfx });
    const elements = Array.from(viewConfigMap.values()).map(
      (config) => config.view.model,
    ) as GfxModel[];

    handler.startRotate({
      ...options,
      elements,
      onRotateStart: (payload) => {
        this.host._activeInteraction$.value = {
          type: "rotate",
          elements,
        };
        options.onRotateStart?.();
        payload.data.forEach(({ model }) => {
          if (!viewConfigMap.has(model.id)) {
            return;
          }

          const { handlers, defaultHandlers, view, constraint } =
            viewConfigMap.get(model.id)!;

          handlers.onRotateStart({
            default: defaultHandlers.onRotateStart as () => void,
            constraint,
            model,
            view,
          });
        });
      },
      onRotateUpdate: (payload) => {
        options.onRotateUpdate?.({
          currentAngle: initialRotate + payload.delta,
          delta: payload.delta,
        });
        payload.data.forEach(
          ({
            model,
            newBound,
            originalBound,
            newRotate,
            originalRotate,
            matrix,
          }) => {
            if (!viewConfigMap.has(model.id)) {
              return;
            }

            const { handlers, defaultHandlers, view, constraint } =
              viewConfigMap.get(model.id)!;

            handlers.onRotateMove({
              model,
              newBound,
              originalBound,
              newRotate,
              originalRotate,
              default: defaultHandlers.onRotateMove as () => void,
              constraint,
              view,
              matrix,
            });
          },
        );
      },
      onRotateEnd: (payload) => {
        this.host._activeInteraction$.value = null;
        options.onRotateEnd?.();
        this.host._std.store.transact(() => {
          payload.data.forEach(({ model }) => {
            if (!viewConfigMap.has(model.id)) {
              return;
            }

            const { handlers, defaultHandlers, view, constraint } =
              viewConfigMap.get(model.id)!;

            handlers.onRotateEnd({
              default: defaultHandlers.onRotateEnd as () => void,
              view,
              model,
              constraint,
            });
          });
        });
      },
    });
  }
}
