import { computed } from "@preact/signals-core";
import { SignalWatcher } from "@virgultum/core/primitives/lit";
import { ConnectorMode, getConnectorModeName } from "@virgultum/core/models";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";

import { ConnectorTool } from "../connector-tool";

export class EdgelessConnectorToolButton extends QuickToolMixin(
  SignalWatcher(LitElement),
) {
  override createRenderRoot() {
    return this;
  }

  private readonly _mode$ = computed(() => {
    return this.edgeless.std.get(EditPropsStore).lastProps$.value.connector
      .mode;
  });

  override type = ConnectorTool;

  private _toggleMenu() {
    if (this.tryDisposePopper()) return;

    const menu = this.createPopper("edgeless-connector-menu", this);
    menu.element.edgeless = this.edgeless;
    menu.element.onChange = (props: Record<string, unknown>) => {
      this.edgeless.std.get(EditPropsStore).recordLastProps("connector", props);
      this.setEdgelessTool(this.type, {
        mode: this._mode$.value,
      });
    };
  }

  override render() {
    const { active } = this;
    const mode = this._mode$.value;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      expanded: this.popper !== null,
      action: {
        id: "canvas-connector",
        label: getConnectorModeName(mode),
        shortcut: "C",
        active,
        disabled: false,
        icon:
          mode === ConnectorMode.Straight
            ? "ConnectorLIcon"
            : mode === ConnectorMode.Orthogonal
              ? "ConnectorEIcon"
              : "ConnectorCIcon",
        run: () => {
          this._toggleMenu();
          this.gfx.tool.setTool(ConnectorTool, { mode });
        },
      },
    });
  }
}
