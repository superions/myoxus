import { type Container, createIdentifier } from "@virgultum/global/di";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { Extension } from "@virgultum/store";

import type { GfxController } from "../../controller.js";
import { GfxControllerIdentifier } from "../../identifiers.js";
import type { GfxModel } from "../../model/model.js";
import type { GfxInteractivityContext, SupportedEvents } from "../event.js";
import type { ExtensionElementsCloneContext } from "../types/clone.js";
import type {
  DragExtensionInitializeContext,
  ExtensionDragEndContext,
  ExtensionDragMoveContext,
  ExtensionDragStartContext,
} from "../types/drag.js";
import type {
  ExtensionElementResizeContext,
  ExtensionElementResizeEndContext,
  ExtensionElementResizeMoveContext,
  ExtensionElementResizeStartContext,
} from "../types/resize.js";
import type { ExtensionElementSelectContext } from "../types/select.js";

export const InteractivityExtensionIdentifier =
  createIdentifier<InteractivityExtension>("interactivity-extension");

export class InteractivityExtension extends Extension {
  static key: string;

  get std() {
    return this.gfx.std;
  }

  event: Omit<InteractivityEventAPI, "emit"> = new InteractivityEventAPI();

  action: Omit<InteractivityActionAPI, "emit"> = new InteractivityActionAPI();

  constructor(protected readonly gfx: GfxController) {
    super();
  }

  mounted() {}

  /**
   * Override this method should call `super.unmounted()`
   */
  unmounted() {
    this.event.destroy();
    this.action.destroy();
  }

  static override setup(di: Container) {
    if (!this.key) {
      throw new VirgultumError(
        ErrorCode.ValueNotExists,
        "key is not defined in the InteractivityExtension",
      );
    }

    di.add(
      this as unknown as { new (gfx: GfxController): InteractivityExtension },
      [GfxControllerIdentifier],
    );
    di.addImpl(InteractivityExtensionIdentifier(this.key), (provider) =>
      provider.get(this),
    );
  }
}

export class InteractivityEventAPI {
  private readonly _handlersMap = new Map<
    SupportedEvents,
    ((evt: GfxInteractivityContext) => void)[]
  >();

  on(
    eventName: SupportedEvents,
    handler: (evt: GfxInteractivityContext) => void,
  ) {
    const handlers = this._handlersMap.get(eventName) ?? [];
    handlers.push(handler);
    this._handlersMap.set(eventName, handlers);

    return () => {
      const idx = handlers.indexOf(handler);

      if (idx > -1) {
        handlers.splice(idx, 1);
      }
    };
  }

  emit(eventName: SupportedEvents, evt: GfxInteractivityContext) {
    const handlers = this._handlersMap.get(eventName);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(evt);
    }
  }

  destroy() {
    this._handlersMap.clear();
  }
}

export type ActionContextMap = {
  moveElements: {
    context: { elements: GfxModel[] };
    returnType: void;
  };
  transformElements: {
    context: { elements: GfxModel[]; operation: "resize" | "rotate" };
    returnType: void;
  };
  dragInitialize: {
    context: DragExtensionInitializeContext;
    returnType: {
      onDragStart?: (context: ExtensionDragStartContext) => void;
      onDragMove?: (context: ExtensionDragMoveContext) => void;
      onDragEnd?: (context: ExtensionDragEndContext) => void;
      clear?: () => void;
    };
  };
  elementsClone: {
    context: ExtensionElementsCloneContext;
    returnType: Promise<
      | {
          elements: GfxModel[];
        }
      | undefined
    >;
  };
  elementResize: {
    context: ExtensionElementResizeContext;
    returnType: {
      onResizeStart?: (context: ExtensionElementResizeStartContext) => void;
      onResizeMove?: (context: ExtensionElementResizeMoveContext) => void;
      onResizeEnd?: (context: ExtensionElementResizeEndContext) => void;
    };
  };
  elementSelect: {
    context: ExtensionElementSelectContext;
    returnType: void;
  };
};

export class InteractivityActionAPI {
  private readonly _handlers: Partial<{
    [K in keyof ActionContextMap]: (
      ctx: ActionContextMap[K]["context"],
    ) => ActionContextMap[K]["returnType"];
  }> = {};

  /** Expand semantic membership for pointer and keyboard movement alike. */
  onMoveElements(
    handler: (ctx: ActionContextMap["moveElements"]["context"]) => void,
  ) {
    this._handlers.moveElements = handler;
    return () => {
      delete this._handlers.moveElements;
    };
  }

  /** Constrain semantic geometry before resize/rotation handles or previews exist. */
  onTransformElements(
    handler: (ctx: ActionContextMap["transformElements"]["context"]) => void,
  ) {
    this._handlers.transformElements = handler;
    return () => {
      delete this._handlers.transformElements;
    };
  }

  onDragInitialize(
    handler: (
      ctx: ActionContextMap["dragInitialize"]["context"],
    ) => ActionContextMap["dragInitialize"]["returnType"],
  ) {
    this._handlers["dragInitialize"] = handler;

    return () => {
      delete this._handlers["dragInitialize"];
    };
  }

  onElementResize(
    handler: (
      ctx: ActionContextMap["elementResize"]["context"],
    ) => ActionContextMap["elementResize"]["returnType"],
  ) {
    this._handlers["elementResize"] = handler;

    return () => {
      return delete this._handlers["elementResize"];
    };
  }

  onRequestElementsClone(
    handler: (
      ctx: ActionContextMap["elementsClone"]["context"],
    ) => ActionContextMap["elementsClone"]["returnType"],
  ) {
    this._handlers["elementsClone"] = handler;

    return () => {
      return delete this._handlers["elementsClone"];
    };
  }

  onElementSelect(
    handler: (
      ctx: ActionContextMap["elementSelect"]["context"],
    ) => ActionContextMap["elementSelect"]["returnType"],
  ) {
    this._handlers["elementSelect"] = handler;

    return () => {
      return delete this._handlers["elementSelect"];
    };
  }

  emit<K extends keyof ActionContextMap>(
    event: K,
    context: ActionContextMap[K]["context"],
  ): ActionContextMap[K]["returnType"] | undefined {
    const handler = this._handlers[event];

    return handler?.(context);
  }

  destroy() {
    for (const key in this._handlers) {
      delete this._handlers[key as keyof typeof this._handlers];
    }
  }
}
