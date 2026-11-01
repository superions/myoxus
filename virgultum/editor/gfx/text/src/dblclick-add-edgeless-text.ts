import { TelemetryProvider } from "@virgultum/shared/services";
import {
  type GfxInteractivityContext,
  InteractivityExtension,
} from "@virgultum/std/gfx";

import { insertEdgelessTextCommand } from "./commands";

export class DblClickAddEdgelessText extends InteractivityExtension {
  static override key = "dbl-click-add-edgeless-text";

  override mounted() {
    this.event.on("dblclick", (ctx: GfxInteractivityContext) => {
      const { event: e } = ctx;
      const picked = this.gfx.getElementByPoint(
        ...this.gfx.viewport.toModelCoord(e.x, e.y),
      );

      if (picked) {
        return;
      }

      const [x, y] = this.gfx.viewport.toModelCoord(e.x, e.y);
      this.std.command.exec(insertEdgelessTextCommand, { x, y });

      this.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "canvas:dbclick",
        page: "whiteboard editor",
        module: "toolbar",
        segment: "toolbar",
        type: "text",
      });
    });
  }
}
