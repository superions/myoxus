import { computed } from "@preact/signals-core";
import { ConnectorMode, getConnectorModeName } from "@virgultum/core/models";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { NativeViewElement } from "@virgultum/core/runtime";
import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { ConnectorTool } from "../connector-tool";

export class EdgelessConnectorToolButton extends QuickToolMixin(
  NativeViewElement,
) {
  private readonly _mode$ = computed(() => {
    return this.edgeless.std.get(EditPropsStore).lastProps$.value.connector
      .mode;
  });

  override type = ConnectorTool;

  private _toggleMenu() {
    if (this.tryDisposePopper()) return;

    this.createPopper("edgeless-connector-menu", this, {
      setProps: (element) => {
        element.edgeless = this.edgeless;
        element.onChange = (props: Record<string, unknown>) => {
          this.edgeless.std
            .get(EditPropsStore)
            .recordLastProps("connector", props);
          this.setEdgelessTool(this.type, {
            mode: this._mode$.value,
          });
        };
      },
    });
  }

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const { active } = this;
    const mode = this._mode$.value;
    this.mountSlot("tool", this, chrome.mountCanvasTool, {
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
