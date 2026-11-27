import type { Constructor } from "@virgultum/core/primitives/utils";
import { NoteBlockModel } from "@virgultum/core/models";
import { DocModeProvider } from "@virgultum/core/services";
import { isInsideEdgelessEditor, matchModels } from "@virgultum/core/utils";
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import type { BlockModel } from "@virgultum/core/store";

import { PeekableController } from "./controller";
import type { PeekableClass, PeekableOptions } from "./type";

const symbol = Symbol("peekable");

export const isPeekable = (e: HTMLElement): boolean => {
  return Reflect.has(e, symbol) && (e as any)[symbol]?.peekable;
};

export const peek = (e: HTMLElement): void => {
  isPeekable(e) && (e as any)[symbol]?.peek();
};

/**
 * Mark a class as peekable, which means the class can be peeked by the peek view service.
 */
export const Peekable =
  <T extends PeekableClass, C extends Constructor<PeekableClass>>(
    options: PeekableOptions<T> = {
      action: ["double-click", "shift-click"],
    },
  ) =>
  (Class: C, context: ClassDecoratorContext) => {
    if (context.kind !== "class") {
      console.error("@Peekable() can only be applied to a class");
      return;
    }

    if (options.action === undefined)
      options.action = ["double-click", "shift-click"];

    const actions = Array.isArray(options.action)
      ? options.action
      : options.action
        ? [options.action]
        : [];

    const derivedClass = class extends Class {
      [symbol] = new PeekableController(this as unknown as T, options.enableOn);

      /**
       * In edgeless mode, we need to check if the click target is not covered by
       * other elements. If it is, we should not show the peek view.
       */
      private _peekableInEdgeless(e: MouseEvent) {
        const docModeService = this.std.getOptional(DocModeProvider);

        if (
          !("model" in this) ||
          !docModeService ||
          docModeService.getEditorMode() !== "edgeless"
        ) {
          return true;
        }

        const model = this["model"] as BlockModel;
        const gfx = this.std.get(GfxControllerIdentifier);
        const hitTarget = gfx.getElementByPoint(
          ...gfx.viewport.toModelCoordFromClientCoord([e.clientX, e.clientY]),
        );

        if (hitTarget && hitTarget !== model) {
          // Check if hitTarget is a GfxBlockElementModel (which extends BlockModel)
          // and if it's a NoteBlockModel, then check if current model is inside it
          if (
            hitTarget instanceof GfxBlockElementModel &&
            matchModels(hitTarget, [NoteBlockModel])
          ) {
            let curModel: BlockModel | null = model;
            while (curModel) {
              if (curModel === hitTarget) {
                return true; // Model is inside the NoteBlockModel, allow peek
              }
              curModel = curModel.parent;
            }
          }
          return false;
        }

        return true;
      }

      override connectedCallback() {
        super.connectedCallback();

        const target: HTMLElement =
          (options.selector ? this.querySelector(options.selector) : this) ||
          this;

        if (actions.includes("double-click")) {
          this.disposables.addFromEvent(target, "dblclick", (e) => {
            if (this[symbol].peekable && this._peekableInEdgeless(e)) {
              e.stopPropagation();
              this[symbol].peek().catch(console.error);
            }
          });
        }
        if (
          actions.includes("shift-click") &&
          // shift click in edgeless should be selection
          !isInsideEdgelessEditor(this.std.host)
        ) {
          this.disposables.addFromEvent(target, "click", (e) => {
            if (
              e.shiftKey &&
              this[symbol].peekable &&
              this._peekableInEdgeless(e)
            ) {
              e.stopPropagation();
              e.stopImmediatePropagation();
              this[symbol].peek().catch(console.error);
            }
          });
        }
      }
    };
    return derivedClass as unknown as C;
  };
