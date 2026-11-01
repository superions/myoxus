// SPDX-License-Identifier: MIT

/**
 * `resize-interaction-manager.ts` - P-VIRG-ARCH-G-02.
 *
 * Resize-Teilmanager fuer den GFX-Interactivity-Manager.
 * Aus `interactivity/manager.ts` extrahiert ohne Verhaltensaenderung
 * (pure Delegation). Beheimatet:
 *
 *   - `_getViewResizeConfig` (L445-567 in manager.ts)
 *   - `getResizeHandlers` (L573-575)
 *   - `handleElementResize` (L577-787)
 *
 * Der Host (`InteractivityManager`) haelt eine Instanz und
 * delegiert die oeffentlichen Methoden weiterhin, damit externe
 * Konsumenten (z.B. `default-tool.ts:118 ff.`) unveraendert
 * funktionieren.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §6.1.1
 *      (P-VIRG-ARCH-G-01 — Verfeinerte Verantwortungs-Kartierung)
 */

import { clamp } from "@virgultum/global/gfx";
import last from "lodash-es/last.js";

import type { GfxBlockComponent } from "../../view/index.js";
import type { GfxModel } from "../model/model.js";
import type { GfxElementModelView } from "../view/view.js";
import type {
  ActionContextMap,
  InteractivityActionAPI,
} from "./extension/base.js";
import type { GfxViewInteractionConfig } from "./extension/view.js";
import { GfxViewInteractionIdentifier } from "./extension/view.js";
import type { InteractivityManager } from "./manager.js";
import {
  DEFAULT_HANDLES,
  type OptionResize,
  ResizeController,
  type ResizeHandle,
} from "./resize/manager.js";
import type { ResizeConstraint } from "./types/view.js";

/**
 * Resize-Teilmanager. Erhaelt eine Back-Reference auf den
 * Host (`InteractivityManager`), weil die Resize-Logik auf
 * `gfx`, `std`, `interactExtensions`, `activeInteraction$` und
 * den geteilten `ResizeController` zugreift.
 *
 * **Negativ-Abnahme:** Wenn der Sub-Manager durch no-op-Stubs
 * ersetzt wird, MUSS die E2E-Spec
 * `e2e/edgeless/resize/` rot werden.
 */
export class ResizeInteractionManager {
  constructor(private readonly host: InteractivityManager) {}

  /**
   * Vor G-02 `_getViewResizeConfig` (L445-567) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  private _getViewResizeConfig(elements: GfxModel[]) {
    const context = { elements: [...elements], operation: "resize" as const };
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

    type ViewResizeHandlers = Required<
      ReturnType<Required<GfxViewInteractionConfig>["handleResize"]>
    >;

    const viewConfigMap = new Map<
      string,
      {
        model: GfxModel;
        view: GfxElementModelView | GfxBlockComponent;
        constraint: Required<ResizeConstraint>;
        handlers: ViewResizeHandlers;
        defaultHandlers: ViewResizeHandlers;
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

      const defaultHandlers: ViewResizeHandlers = {
        beforeResize: () => {},
        onResizeStart: () => {
          model.stash("xywh");
        },
        onResizeEnd: () => {
          model.pop("xywh");
        },
        onResizeMove: (context) => {
          const { newBound, constraint } = context;
          const { minWidth, minHeight, maxWidth, maxHeight } = constraint;

          newBound.w = clamp(newBound.w, minWidth, maxWidth);
          newBound.h = clamp(newBound.h, minHeight, maxHeight);

          model.xywh = newBound.serialize();
        },
      };
      const handlers = interactionConfig?.handleResize?.({
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
        constraint: {
          lockRatio: false,
          allowedHandlers: DEFAULT_HANDLES,
          minHeight: 2,
          minWidth: 2,
          maxHeight: 5000000,
          maxWidth: 5000000,
          ...interactionConfig?.resizeConstraint,
        },
        defaultHandlers,
        handlers: Object.assign({}, defaultHandlers, handlers ?? {}),
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
    let allowedHandlers = new Set(viewConfigMap.size ? DEFAULT_HANDLES : []);

    viewConfigMap.forEach((config) => {
      const currConstraint: Required<ResizeConstraint> = config.constraint;

      config.handlers.beforeResize({
        set: (newConstraint: ResizeConstraint) => {
          Object.assign(currConstraint, newConstraint);
        },
        elements: views,
      });

      config.constraint = currConstraint;

      const currentAllowedHandlers = new Set(currConstraint.allowedHandlers);
      allowedHandlers.forEach((h) => {
        if (!currentAllowedHandlers.has(h)) {
          allowedHandlers.delete(h);
        }
      });
    });

    return {
      allowedHandlers: Array.from(allowedHandlers) as ResizeHandle[],
      viewConfigMap,
    };
  }

  /**
   * Vor G-02 `getResizeHandlers` (L573-575) im
   * `InteractivityManager`. Verhalten unveraendert, mit einer
   * Korrektur:
   *
   * **G-FIND-02:** vor dem Fix lieferte die Funktion fuer eine
   * leere `elements`-Liste das volle `DEFAULT_HANDLES`-Set
   * (Initial-Value von `allowedHandlers`, weil `viewConfigMap`
   * leer bleibt und `forEach` 0-mal laeuft). Das ist
   * semantisch falsch: ohne Selektion gibt es keine Handles
   * zum Anzeigen. Konsumenten wie
   * `editor/widgets/edgeless-selected-rect` filtern
   * zwar separat nach `elements.length > 0`, aber die
   * Funktion SOLLTE die Wahrheit ueber die Selektion
   * ausdruecken, nicht eine Default-Annahme.
   *
   * **Fix:** early return `[]` fuer leere `elements`. Das ist
   * die ehrliche Antwort und konsistent mit der
   * Intersection-Logik weiter unten (mehrere Elemente
   * schraenken die erlaubten Handles ein; 0 Elemente
   * schraenken sie auf `[]` ein).
   */
  getResizeHandlers(options: { elements: GfxModel[] }): ResizeHandle[] {
    if (options.elements.length === 0) {
      return [];
    }
    return this._getViewResizeConfig(options.elements).allowedHandlers;
  }

  /**
   * Vor G-02 `handleElementResize` (L577-787) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  handleElementResize(
    options: Omit<
      OptionResize,
      | "lockRatio"
      | "onResizeStart"
      | "onResizeEnd"
      | "onResizeUpdate"
      | "onResizeMove"
    > & {
      onResizeStart?: () => void;
      onResizeEnd?: () => void;
      onResizeUpdate?: (payload: {
        lockRatio: boolean;
        scaleX: number;
        scaleY: number;
        exceed: {
          w: boolean;
          h: boolean;
        };
      }) => void;
    },
  ): void {
    const { viewConfigMap, allowedHandlers } = this._getViewResizeConfig(
      options.elements,
    );

    if (!allowedHandlers.includes(options.handle)) {
      return;
    }

    const { handle } = options;
    const controller = new ResizeController({ gfx: this.host._gfx });
    const elements = Array.from(viewConfigMap.values()).map(
      (config) => config.view.model,
    ) as GfxModel[];
    const extensionHandlers = this.host._interactExtensions.values().reduce(
      (handlers, ext) => {
        const extHandlers = (ext.action as InteractivityActionAPI).emit(
          "elementResize",
          {
            elements,
          },
        );

        if (extHandlers) {
          handlers.push(extHandlers);
        }

        return handlers;
      },
      [] as ActionContextMap["elementResize"]["returnType"][],
    );
    let lockRatio = false;

    viewConfigMap.forEach((config) => {
      const { lockRatio: lockRatioConfig } = config.constraint;

      lockRatio =
        lockRatio ||
        lockRatioConfig === true ||
        (Array.isArray(lockRatioConfig) && lockRatioConfig.includes(handle));
    });

    controller.startResize({
      ...options,
      lockRatio,
      elements,
      onResizeMove: ({
        scaleX,
        scaleY,
        originalBound,
        handleSign,
        handlePos,
        currentHandlePos,
        lockRatio,
      }) => {
        const suggested: {
          scaleX: number;
          scaleY: number;
          priority?: number;
        }[] = [];
        const suggest = (distance: { scaleX: number; scaleY: number }) => {
          suggested.push(distance);
        };

        extensionHandlers.forEach((ext) => {
          ext.onResizeMove?.({
            scaleX,
            scaleY,
            elements,
            handle,
            handleSign,
            handlePos,
            originalBound,
            currentHandlePos,
            lockRatio,
            suggest,
          });
        });

        suggested.sort((a, b) => {
          return (a.priority ?? 0) - (b.priority ?? 0);
        });

        return last(suggested) ?? { scaleX, scaleY };
      },
      onResizeStart: ({ handleSign, handlePos, data }) => {
        this.host._activeInteraction$.value = {
          type: "resize",
          elements,
        };
        extensionHandlers.forEach((ext) => {
          ext.onResizeStart?.({
            elements,
            handle,
            handlePos,
            handleSign,
          });
        });

        options.onResizeStart?.();
        data.forEach(({ model }) => {
          if (!viewConfigMap.has(model.id)) {
            return;
          }

          const { handlers, defaultHandlers, view, constraint } =
            viewConfigMap.get(model.id)!;

          handlers.onResizeStart({
            handle,
            default: defaultHandlers.onResizeStart as () => void,
            constraint,
            model,
            view,
          });
        });
      },
      onResizeUpdate: ({ data, scaleX, scaleY, lockRatio }) => {
        const exceed = {
          w: false,
          h: false,
        };

        data.forEach(
          ({ model, newBound, originalBound, lockRatio, matrix }) => {
            if (!viewConfigMap.has(model.id)) {
              return;
            }

            const { handlers, defaultHandlers, view, constraint } =
              viewConfigMap.get(model.id)!;

            handlers.onResizeMove({
              model,
              newBound,
              originalBound,
              handle,
              default: defaultHandlers.onResizeMove as () => void,
              constraint,
              view,
              lockRatio,
              matrix,
            });

            exceed.w =
              exceed.w ||
              model.w === constraint.minWidth ||
              model.w === constraint.maxWidth;
            exceed.h =
              exceed.h ||
              model.h === constraint.minHeight ||
              model.h === constraint.maxHeight;
          },
        );

        options.onResizeUpdate?.({ scaleX, scaleY, lockRatio, exceed });
      },
      onResizeEnd: ({ handleSign, handlePos, data }) => {
        this.host._activeInteraction$.value = null;

        extensionHandlers.forEach((ext) => {
          ext.onResizeEnd?.({
            elements,
            handle,
            handlePos,
            handleSign,
          });
        });
        options.onResizeEnd?.();
        this.host._std.store.transact(() => {
          data.forEach(({ model }) => {
            if (!viewConfigMap.has(model.id)) {
              return;
            }

            const { handlers, defaultHandlers, view, constraint } =
              viewConfigMap.get(model.id)!;

            handlers.onResizeEnd({
              default: defaultHandlers.onResizeEnd as () => void,
              view,
              model,
              constraint,
              handle,
            });
          });
        });
      },
    });
  }
}
