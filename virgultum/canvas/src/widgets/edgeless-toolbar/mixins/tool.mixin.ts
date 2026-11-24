import { cssVar } from "@myoxus/theme";
import { effect } from "@preact/signals-core";
import {
  // oxlint-disable-next-line no-unused-vars
  type DisposableClass,
  WithDisposable,
} from "@virgultum/core/primitives/lit";
import type { Constructor } from "@virgultum/core/primitives/utils";
import type { BlockComponent } from "@virgultum/core/runtime";
import {
  type GfxController,
  GfxControllerIdentifier,
  type ToolController,
  type ToolOptionWithType,
  type ToolType,
} from "@virgultum/core/runtime/gfx";
import type { LitElement } from "lit";
import { property, state } from "lit/decorators.js";

import { createPopper, type MenuPopper } from "../create-popper";
import {
  EDGELESS_TOOLBAR_WIDGET,
  type EdgelessToolbarWidget,
} from "../edgeless-toolbar";

export declare abstract class EdgelessToolbarToolClass extends DisposableClass {
  active: boolean;

  createPopper: typeof createPopper;

  edgeless: BlockComponent;

  edgelessTool: ToolOptionWithType;

  enableActiveBackground?: boolean;

  popper: MenuPopper<HTMLElement> | null;

  setEdgelessTool: ToolController["setTool"];

  gfx: GfxController;

  toolbarContainer: HTMLElement | null;

  /**
   * @return true if operation was successful
   */
  tryDisposePopper: () => boolean;

  abstract type: ToolType | ToolType[];

  readonly toolbar: EdgelessToolbarWidget;
}

export const EdgelessToolbarToolMixin = <T extends Constructor<LitElement>>(
  SuperClass: T,
) => {
  abstract class DerivedClass extends WithDisposable(SuperClass) {
    enableActiveBackground = false;

    abstract type: ToolType | ToolType[];

    get active() {
      const { type } = this;
      const activeType = this.edgelessTool?.toolType;

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

    override connectedCallback() {
      super.connectedCallback();
      if (!this.edgeless) return;
      this._updateActiveEdgelessTool();
      this._applyActiveStyle();

      this._disposables.add(
        effect(() => {
          this._updateActiveEdgelessTool();
        }),
      );
    }

    // TODO: move to toolbar-tool-with-menu.mixin
    createPopper(...args: Parameters<typeof createPopper>) {
      if (this.toolbar.activePopper) {
        this.toolbar.activePopper.dispose();
        this.toolbar.activePopper = null;
      }
      this.popper = createPopper(args[0], args[1], {
        ...args[2],
        onDispose: () => {
          args[2]?.onDispose?.();
          this.popper = null;
        },
      }) as MenuPopper<HTMLElement>;
      this.toolbar.activePopper = this.popper;
      return this.popper;
    }

    override disconnectedCallback() {
      super.disconnectedCallback();
      this.popper?.dispose();
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

    @property({ attribute: false })
    accessor edgeless!: BlockComponent;

    @state()
    accessor edgelessTool!: ToolOptionWithType | null;

    @state()
    public accessor popper: MenuPopper<HTMLElement> | null = null;

    get toolbar() {
      return this.edgeless.std.view.getWidget(
        EDGELESS_TOOLBAR_WIDGET,
        this.edgeless.model.id,
      ) as EdgelessToolbarWidget;
    }

    @property({ attribute: false })
    accessor toolbarContainer: HTMLElement | null = null;
  }

  return DerivedClass as unknown as T & Constructor<EdgelessToolbarToolClass>;
};
