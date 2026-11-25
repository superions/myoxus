import { cssVar } from "@myoxus/theme";
import { effect, signal, type ReadonlySignal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { Constructor } from "@virgultum/core/primitives/utils";
import type { BlockComponent } from "@virgultum/core/runtime";
import {
  type GfxController,
  GfxControllerIdentifier,
  type ToolController,
  type ToolOptionWithType,
  type ToolType,
} from "@virgultum/core/runtime/gfx";

import {
  EditorChromeHostIdentifier,
  type EditorCanvasPopoverControls,
} from "@virgultum/core/services";
import {
  type CanvasToolPopper,
  EDGELESS_TOOLBAR_WIDGET,
  type EdgelessToolbarWidget,
} from "../edgeless-toolbar";

export type MenuPopper<T extends HTMLElement> = CanvasToolPopper & {
  element: T;
};

export type CreatePopperOptions<T extends keyof HTMLElementTagNameMap> = {
  duration?: number;
  onDispose?: () => void;
  setProps?: (ele: HTMLElementTagNameMap[T]) => void;
};

export interface NativeReactiveController {
  hostConnected?: () => void;
  hostDisconnected?: () => void;
}

export declare abstract class EdgelessToolbarToolClass {
  protected _disposables: DisposableGroup;

  readonly disposables: DisposableGroup;

  active: boolean;

  createPopper: <T extends keyof HTMLElementTagNameMap>(
    tagName: T,
    reference: HTMLElement,
    options?: CreatePopperOptions<T>,
  ) => MenuPopper<HTMLElementTagNameMap[T]>;

  edgeless: BlockComponent;

  edgelessTool: ToolOptionWithType | null;

  enableActiveBackground?: boolean;

  popper: MenuPopper<HTMLElement> | null;

  setEdgelessTool: ToolController["setTool"];

  gfx: GfxController;

  toolbarContainer: HTMLElement | null;

  addController(controller: NativeReactiveController): void;

  requestUpdate(): void;

  connectedCallback(): void;

  disconnectedCallback(): void;

  protected onConnected(): void;

  protected paint(): void;

  protected mountSlot<Controls>(
    key: string,
    container: HTMLElement,
    mount: (
      anchor: HTMLElement,
      state: ReadonlySignal<Controls | null>,
    ) => () => void,
    controls: Controls | null,
  ): void;

  protected clearSlots(): void;

  /**
   * @return true if operation was successful
   */
  tryDisposePopper(): boolean;

  abstract type: ToolType | ToolType[];

  readonly toolbar: EdgelessToolbarWidget;
}

export const EdgelessToolbarToolMixin = <T extends Constructor<HTMLElement>>(
  SuperClass: T,
) => {
  abstract class DerivedClass extends SuperClass {
    protected _disposables = new DisposableGroup();
    private _edgeless!: BlockComponent;
    private _edgelessTool: ToolOptionWithType | null = null;
    private _popper: MenuPopper<HTMLElement> | null = null;
    private _toolbarContainer: HTMLElement | null = null;
    private readonly _revision$ = signal(0);
    private readonly _controllers = new Set<NativeReactiveController>();
    private readonly _slots = new Map<
      string,
      {
        host: HTMLSpanElement;
        state$: ReturnType<typeof signal<unknown>>;
        unmount: () => void;
      }
    >();
    private _bound = false;

    enableActiveBackground = false;

    abstract type: ToolType | ToolType[];

    get disposables() {
      return this._disposables;
    }

    get edgeless() {
      return this._edgeless;
    }

    set edgeless(value: BlockComponent) {
      if (this._edgeless === value) return;
      this._edgeless = value;
      if (this.isConnected) {
        this._ensureBound();
        this.requestUpdate();
      }
    }

    get edgelessTool() {
      return this._edgelessTool;
    }

    set edgelessTool(value: ToolOptionWithType | null) {
      if (this._edgelessTool === value) return;
      this._edgelessTool = value;
      this.requestUpdate();
    }

    get popper() {
      return this._popper;
    }

    set popper(value: MenuPopper<HTMLElement> | null) {
      if (this._popper === value) return;
      this._popper = value;
      this.requestUpdate();
    }

    get toolbarContainer() {
      return this._toolbarContainer;
    }

    set toolbarContainer(value: HTMLElement | null) {
      if (this._toolbarContainer === value) return;
      this._toolbarContainer = value;
      this.requestUpdate();
    }

    get active() {
      const { type } = this;
      const activeType = this._edgelessTool?.toolType;

      return activeType
        ? Array.isArray(type)
          ? type.includes(activeType)
          : activeType === type
        : false;
    }

    get gfx() {
      return this.edgeless.std.get(GfxControllerIdentifier);
    }

    get setEdgelessTool() {
      return this.gfx.tool.setTool;
    }

    addController(controller: NativeReactiveController) {
      this._controllers.add(controller);
      if (this.isConnected && this._bound) {
        controller.hostConnected?.();
      }
    }

    requestUpdate() {
      this._revision$.value = this._revision$.peek() + 1;
    }

    protected onConnected() {}

    protected paint() {}

    protected mountSlot<Controls>(
      key: string,
      container: HTMLElement,
      mount: (
        anchor: HTMLElement,
        state: ReadonlySignal<Controls | null>,
      ) => () => void,
      controls: Controls | null,
    ) {
      let slot = this._slots.get(key);
      if (!slot) {
        const host = this.ownerDocument.createElement("span");
        host.style.display = "contents";
        container.append(host);
        const state$ = signal<Controls | null>(controls);
        const unmount = mount(host, state$);
        slot = {
          host,
          state$: state$ as ReturnType<typeof signal<unknown>>,
          unmount,
        };
        this._slots.set(key, slot);
        return;
      }
      if (slot.host.parentElement !== container) {
        container.append(slot.host);
      }
      slot.state$.value = controls;
    }

    protected clearSlots() {
      for (const slot of this._slots.values()) {
        slot.unmount();
        slot.host.remove();
      }
      this._slots.clear();
    }

    private _applyActiveStyle() {
      if (!this.enableActiveBackground) return;
      this.style.background = this.active
        ? cssVar("hoverColor")
        : "transparent";
    }

    private _updateActiveEdgelessTool() {
      this.edgelessTool = this.gfx.tool.currentToolOption$.value;
      this._applyActiveStyle();
    }

    private _ensureBound() {
      if (this._bound || !this.isConnected || !this._edgeless) return;
      this._bound = true;
      if (this._disposables.disposed) {
        this._disposables = new DisposableGroup();
      }
      this._updateActiveEdgelessTool();
      this._applyActiveStyle();

      this._disposables.add(
        effect(() => {
          this._updateActiveEdgelessTool();
        }),
      );
      this.onConnected();
      for (const controller of this._controllers) {
        controller.hostConnected?.();
      }
      this._disposables.add(
        effect(() => {
          void this._revision$.value;
          if (!this.isConnected || !this._edgeless) return;
          this.paint();
        }),
      );
    }

    connectedCallback() {
      this._ensureBound();
    }

    createPopper<T extends keyof HTMLElementTagNameMap>(
      tagName: T,
      reference: HTMLElement,
      options?: CreatePopperOptions<T>,
    ): MenuPopper<HTMLElementTagNameMap[T]> {
      if (this.toolbar?.activePopper) {
        this.toolbar.activePopper.dispose();
        this.toolbar.activePopper = null;
      }

      const menu = reference.ownerDocument.createElement(tagName);
      options?.setProps?.(menu);

      let disposed = false;
      const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
      let unmountPopover: (() => void) | null = null;
      let popoverAnchor: HTMLSpanElement | null = null;

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        unmountPopover?.();
        unmountPopover = null;
        popoverAnchor?.remove();
        popoverAnchor = null;
        menu.remove();
        if (this.toolbar?.activePopper === popper) {
          this.toolbar.activePopper = null;
        }
        this.popper = null;
        options?.onDispose?.();
      };

      const popper: MenuPopper<HTMLElementTagNameMap[T]> = {
        element: menu,
        dispose: cleanup,
      };

      if (chrome?.mountCanvasPopover) {
        reference.style.position ||= "relative";
        popoverAnchor = reference.ownerDocument.createElement("span");
        popoverAnchor.style.position = "absolute";
        popoverAnchor.style.inset = "0";
        popoverAnchor.style.pointerEvents = "none";
        reference.append(popoverAnchor);

        const state$ = signal<EditorCanvasPopoverControls | null>({
          opened: true,
          onClose: cleanup,
          position: "top",
          offset: 16,
          closeOnClickOutside: false,
          content: {
            kind: "native",
            mount: (host) => {
              host.append(menu);
              return () => {
                menu.remove();
              };
            },
          },
        });
        unmountPopover = chrome.mountCanvasPopover(popoverAnchor, state$);
      } else {
        reference.append(menu);
      }

      this.popper = popper;
      if (this.toolbar) {
        this.toolbar.activePopper = popper;
      }
      return popper;
    }

    disconnectedCallback() {
      for (const controller of this._controllers) {
        controller.hostDisconnected?.();
      }
      this.popper?.dispose();
      this._popper = null;
      this.clearSlots();
      this._disposables.dispose();
      this._bound = false;
    }

    tryDisposePopper() {
      if (!this.active) return false;
      if (this.popper) {
        this.popper.dispose();
        this.popper = null;
        return true;
      }
      return false;
    }

    get toolbar() {
      return this.edgeless.std.view.getWidget(
        EDGELESS_TOOLBAR_WIDGET,
        this.edgeless.model.id,
      ) as EdgelessToolbarWidget;
    }
  }

  return DerivedClass as unknown as T & Constructor<EdgelessToolbarToolClass>;
};
